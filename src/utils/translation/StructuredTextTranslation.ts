/**
 * StructuredTextTranslation.ts
 * ------------------------------------------------------
 * This file manages translations of structured text fields from DatoCMS.
 * It handles extracting text nodes, translating block nodes, and reassembling
 * the content after translation while preserving the original structure.
 * 
 * The module provides functionality to:
 * - Extract and track text values from structured text nodes
 * - Process block nodes separately to maintain rich formatting
 * - Translate content while preserving structure
 * - Handle streaming responses from OpenAI API
 */

import { chatComplete, type ChatMsg } from '../../lib/openaiProxy';
import type { ctxParamsType } from '../../entrypoints/Config/ConfigScreen';
import { translateFieldValue } from './TranslateField';
import { createLogger } from '../logging/Logger';
import {
  extractTextValues,
  reconstructObject,
  insertObjectAtIndex,
  removeIds
} from './utils';

/**
 * Callback interfaces for handling streaming responses
 * @interface StreamCallbacks
 * @property {Function} onStream - Callback function for handling each stream chunk
 * @property {Function} onComplete - Callback function triggered when streaming completes
 * @property {Function} checkCancellation - Function to check if translation should be cancelled
 * @property {AbortSignal} abortSignal - Signal to abort the translation process
 */
type StreamCallbacks = {
  onStream?: (chunk: string) => void;
  onComplete?: () => void;
  checkCancellation?: () => boolean;
  abortSignal?: AbortSignal;
};

/**
 * Interface representing a structured text node from DatoCMS
 * Includes standard properties and allows for additional dynamic properties
 * 
 * @interface StructuredTextNode
 * @property {string} type - Node type (e.g., 'paragraph', 'heading', 'block')
 * @property {string} value - Text content of the node
 * @property {string} item - Reference to a linked item
 * @property {number} originalIndex - Original position in the document (for tracking)
 */
interface StructuredTextNode {
  type?: string;
  value?: string;
  item?: string;
  originalIndex?: number;
  [key: string]: unknown;
}

/**
 * Ensures the array lengths match, with fallback strategies if they don't
 * 
 * @param {string[]} originalValues - Original array of text values 
 * @param {string[]} translatedValues - Translated array that might need adjustment
 * @returns {string[]} - Adjusted translated values array matching original length
 */
function ensureArrayLengthsMatch(originalValues: string[], translatedValues: string[]): string[] {
  if (originalValues.length === translatedValues.length) {
    return translatedValues;
  }
  
  // If too few elements, pad with values from the original array
  if (translatedValues.length < originalValues.length) {
    return [
      ...translatedValues,
      ...originalValues.slice(translatedValues.length).map(val => 
        // If it's an empty string, keep it empty
        // Otherwise use the original value
        val.trim() === '' ? '' : val
      )
    ];
  }
  
  // If too many elements, truncate to match original length
  return translatedValues.slice(0, originalValues.length);
}

/**
 * Translates a structured text field value while preserving its structure
 * 
 * @param {unknown} fieldValue - The structured text field value to translate
 * @param {ctxParamsType} pluginParams - Plugin configuration parameters
 * @param {string} toLocale - Target locale code
 * @param {string} fromLocale - Source locale code
 * @param {OpenAI} openai - OpenAI client instance
 * @param {string} apiToken - DatoCMS API token
 * @param {StreamCallbacks} streamCallbacks - Optional callbacks for streaming responses
 * @param {string} recordContext - Optional context about the record being translated
 * @returns {Promise<unknown>} - The translated structured text value
 */
export async function translateStructuredTextValue(
  initialValue: unknown,
  pluginParams: ctxParamsType,
  toLocale: string,
  fromLocale: string,
  apiToken: string,
  environment: string,
  streamCallbacks?: StreamCallbacks,
  recordContext = ''
): Promise<unknown> {
  // Create logger
  const logger = createLogger(pluginParams, 'StructuredTextTranslation');
  
  let fieldValue = initialValue;
  let isAPIResponse = false;

  if((fieldValue as { document: { children: unknown[] } })?.document?.children?.length) {
    fieldValue = (fieldValue as { document: { children: unknown[] } })?.document?.children
    isAPIResponse = true
  }

  // Skip translation if null or not an array
  if (!fieldValue || (!Array.isArray(fieldValue) || fieldValue.length === 0)) {
    logger.info('Invalid structured text value', fieldValue);
    return fieldValue;
  }

  logger.info('Translating structured text field', { nodeCount: fieldValue.length });

  // Remove any 'id' fields
  const noIdFieldValue = removeIds(fieldValue) as StructuredTextNode[];

  // Separate out block nodes and track their original positions
  const blockNodes = noIdFieldValue.reduce<StructuredTextNode[]>(
    (acc, node, index) => {
      if (node?.type === 'block') {
        acc.push({ ...node, originalIndex: index });
      }
      return acc;
    },
    []
  );

  // Filter out block nodes for inline translation first
  const fieldValueWithoutBlocks = noIdFieldValue.filter(
    (node) => node?.type !== 'block'
  );

  // Extract text strings from the structured text
  const textValues = extractTextValues(fieldValueWithoutBlocks);
  
  if (textValues.length === 0) {
    logger.info('No text values found to translate');
    return fieldValue;
  }

  logger.info(`Found ${textValues.length} text nodes to translate`);

  // Format locales for better prompt clarity
  const localeMapper = new Intl.DisplayNames([fromLocale], { type: 'language' });
  const fromLocaleName = localeMapper.of(fromLocale) || fromLocale;
  const toLocaleName = localeMapper.of(toLocale) || toLocale;

  // Build prompts in batches to avoid token overflow on large rich text
  const explicitRules = (expectedCount: number) => `
IMPORTANT: Your response must be a valid JSON array of strings with EXACTLY ${expectedCount} elements. Each element corresponds to the same position in the original array.
- Preserve ALL empty strings - do not remove or modify them
- Maintain the exact array length
- Return only the array of strings in valid JSON format
- Do not nest the array in an object
- Preserve all whitespace and spacing patterns`;

  // Helper to produce a single-batch prompt for a slice of values
  const makePromptForSlice = (slice: string[], totalCount: number) =>
    (pluginParams.prompt || '')
      .replace(
        '{fieldValue}',
        `translate the following string array ${JSON.stringify(slice, null, 2)}`
      )
      .replace('{fromLocale}', fromLocaleName)
      .replace('{toLocale}', toLocaleName)
      .replace(
        '{recordContext}',
        recordContext || 'Record context: No additional context available.'
      ) + `\n${explicitRules(slice.length)}\nThis slice is part of a larger array of ${totalCount} items; keep order.`;

  // Partition textValues into batches such that prompt length stays under ~6000 chars
  const batches: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const v of textValues) {
    const estimated = currentLen + (v?.length || 0);
    if (estimated > 4800 && current.length > 0) {
      batches.push(current);
      current = [v as string];
      currentLen = (v?.length || 0);
    } else {
      current.push(v as string);
      currentLen = estimated;
    }
  }
  if (current.length) batches.push(current);

  logger.logPrompt('Structured text translation prompt (batched)', `batches=${batches.length}`);

  try {
    const allTranslated: string[] = [];
    for (const slice of batches) {
      const prompt = makePromptForSlice(slice, textValues.length);
      const messages: ChatMsg[] = [{ role: 'user', content: prompt }];
      const translatedText = await chatComplete(messages, {
        model: pluginParams.gptModel || 'gpt-5',
        maxTokens: 800,
      });
    if (streamCallbacks?.onComplete) {
      streamCallbacks.onComplete();
    }
    logger.logResponse('Structured text translation response', translatedText);
    try {
      // Clean up response text to handle cases where API might return non-JSON format
      const cleanedTranslatedText = translatedText.trim()
        // If response starts with backticks (code block), remove them
        .replace(/^```json\n/, '')
        .replace(/^```\n/, '')
        .replace(/\n```$/, '');
      
      const translatedValues = JSON.parse(cleanedTranslatedText);

      if (!Array.isArray(translatedValues)) {
        logger.warning('Translation response is not an array', translatedValues);
        return fieldValue;
      }

      // Append translated slice keeping order
      allTranslated.push(...translatedValues);
    } catch (jsonError) {
      logger.error('Failed to parse translation response as JSON', jsonError);
      logger.error('Raw response text', { text: translatedText });
      // Skip this slice and continue with others
      continue;
    }

    // Check for length mismatch and attempt recovery
    let processedTranslatedValues = allTranslated;
    if (processedTranslatedValues.length !== textValues.length) {
      logger.warning(
        `Translation mismatch: got ${processedTranslatedValues.length} values, expected ${textValues.length}`,
        { originalCount: textValues.length }
      );
      processedTranslatedValues = ensureArrayLengthsMatch(textValues, processedTranslatedValues);
    }

    // Reconstruct the inline text portion with the newly translated text
    const reconstructedObject = reconstructObject(
      fieldValueWithoutBlocks,
      processedTranslatedValues
    ) as StructuredTextNode[];

      // Insert block nodes back into their original positions
      let finalReconstructedObject = reconstructedObject;

      // If there are block nodes, translate them separately
      if (blockNodes.length > 0) {
        logger.info(`Translating ${blockNodes.length} block nodes`);
        
        // Key change: Pass the entire blockNodes array to translateFieldValue
        // and use 'rich_text' as the field type instead of translating each block separately
        const translatedBlockNodes = await translateFieldValue(
          blockNodes,
          pluginParams,
          toLocale,
          fromLocale,
          'rich_text', // Use rich_text instead of block
          '',
          apiToken,
          '',
          environment,
          streamCallbacks,
          recordContext
        ) as StructuredTextNode[];

        // Insert translated blocks back at their original positions
        for (const node of translatedBlockNodes) {
          if (node.originalIndex !== undefined) {
            finalReconstructedObject = insertObjectAtIndex(
              finalReconstructedObject,
              node,
              node.originalIndex
            );
          }
        }
      }

      // Remove temporary 'originalIndex' keys
      const cleanedReconstructedObject = (finalReconstructedObject as StructuredTextNode[]).map(
        ({ originalIndex, ...rest }) => rest
      );

      if(isAPIResponse) {
        return {
          document: {
            children: cleanedReconstructedObject,
            type: "root"
          },
          schema: "dast"
        }
      }

      logger.info('Successfully translated structured text');
      return cleanedReconstructedObject;
    } catch (jsonError) {
      logger.error('Failed to parse translation response as JSON', jsonError);
      // More descriptive error information to help with debugging
      logger.error('Raw response text', { text: translatedText });
      return fieldValue;
    }
  } catch (error) {
    logger.error('Error during structured text translation', error);
    return fieldValue;
  }
}
