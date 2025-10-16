/**
 * translateRecordFields.ts
 * ------------------------------------------------------
 * This module provides functionality for batch translating all localizable fields
 * in a DatoCMS record from a source locale to multiple target locales.
 * 
 * The module orchestrates the translation process by:
 * 1. Filtering fields to identify which ones are localizable and translatable
 * 2. Managing the translation workflow for each field-locale combination
 * 3. Providing real-time progress updates via callbacks
 * 4. Supporting cancellation of in-progress translations
 * 5. Automatically updating form values with translated content
 * 
 * This serves as the foundation for the record-level translation features in the plugin.
 */

import type { RenderItemFormSidebarPanelCtx } from 'datocms-plugin-sdk';
// (kept intentionally empty – proxy helper imported elsewhere)
import {
  type ctxParamsType,
  modularContentVariations,
} from '../entrypoints/Config/ConfigScreen';
import { fieldPrompt } from '../prompts/FieldPrompts';
import { translateFieldValue, generateRecordContext } from './translation/TranslateField';

/**
 * Options interface for the translation process
 * 
 * Provides callback hooks that allow the UI to respond to translation events
 * and enables cancellation support for long-running translations.
 * 
 * @interface TranslateOptions
 * @property {Function} onStart - Called when translation starts for a field-locale pair
 * @property {Function} onComplete - Called when translation completes for a field-locale pair
 * @property {Function} onStream - Called with incremental translation results
 * @property {Function} checkCancellation - Function to check if translation should be cancelled
 * @property {AbortSignal} abortSignal - Signal for aborting translation operation
 */
type TranslateOptions = {
  onStart?: (fieldLabel: string, locale: string, fieldPath: string) => void;
  onComplete?: (fieldLabel: string, locale: string) => void;
  onStream?: (fieldLabel: string, locale: string, content: string) => void;
  checkCancellation?: () => boolean;
  abortSignal?: AbortSignal;
};

/**
 * Interface for a field with localized values
 * 
 * Represents a map where keys are locale codes and values are the field content
 * in that specific locale.
 * 
 * @interface LocalizedField
 * @property {unknown} [locale] - Field value for the specified locale
 */
interface LocalizedField {
  [locale: string]: unknown;
}

/**
 * Translates all eligible fields in a record to multiple target locales
 * 
 * This function is the main entry point for batch translating record fields. It:
 * 1. Identifies which fields are localizable and configured for translation
 * 2. Extracts values from the source locale
 * 3. Translates each field to each target locale using the appropriate specialized translator
 * 4. Updates the form values with the translated content
 * 5. Provides progress feedback through the supplied callback functions
 * 
 * Translation can be cancelled at any point using the checkCancellation callback
 * or the abortSignal.
 * 
 * @param {RenderItemFormSidebarPanelCtx} ctx - DatoCMS sidebar context providing access to form values and fields
 * @param {ctxParamsType} pluginParams - Plugin configuration parameters
 * @param {string[]} targetLocales - Array of locale codes to translate into
 * @param {string} sourceLocale - Source locale code to translate from
 * @param {TranslateOptions} options - Optional callbacks and cancellation controls
 * @returns {Promise<void>} - Resolves when all translations are complete or cancelled
 */
export async function translateRecordFields(
  ctx: RenderItemFormSidebarPanelCtx,
  pluginParams: ctxParamsType,
  targetLocales: string[],
  sourceLocale: string,
  options: TranslateOptions = {}
): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type Job = () => Promise<void>;
  async function runPool(jobs: Job[], concurrency = 3) {
    let i = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (i < jobs.length) {
        const idx = i++;
        try { await jobs[idx](); } catch {/* already handled per job */}
        await sleep(60);
      }
    });
    await Promise.all(workers);
  }
  // OpenAI SDK removed; all calls go through helper proxy

  const currentFormValues = ctx.formValues;
  // --- Batched writes to reduce validation traffic ---
  const pendingWrites = new Map<string, unknown>();
  let writeTimer: number | null = null;
  function queueFieldWrite(key: string, value: unknown) {
    pendingWrites.set(key, value);
    if (writeTimer == null) writeTimer = window.setTimeout(flushWrites, 250);
  }
  async function flushWrites() {
    if (!pendingWrites.size) { writeTimer = null; return; }
    const entries = Array.from(pendingWrites.entries());
    pendingWrites.clear();
    writeTimer = null;
    if (!ctx?.formValues) return;
    for (const [k, v] of entries) {
      await ctx.setFieldValue(k, v);
      await sleep(80);
    }
  }

  // Get all fields that belong to the current item type
  const fieldsArray = Object.values(ctx.fields).filter(
    (field) => field?.relationships.item_type.data.id === ctx.itemType.id
  );

    // Process each field sequentially (fault-tolerant)
    for (const field of fieldsArray) {
    if (!field || !field.attributes) {
      continue; // Skip invalid fields
    }
    
    // Check for user-initiated cancellation
    if (options.checkCancellation?.()) {
      return; // Exit early if translation was cancelled
    }
    
    const fieldType = field.attributes.appearance.editor;
    const fieldValue = currentFormValues[field.attributes.api_key];

    // Determine if this field is eligible for translation based on configuration
    let isFieldTranslatable =
      pluginParams.translationFields.includes(fieldType);

    // Handle special cases for rich_text/modular content and file/gallery fields
    if (
      (pluginParams.translationFields.includes('rich_text') &&
        modularContentVariations.includes(fieldType)) ||
      (pluginParams.translationFields.includes('file') &&
        fieldType === 'gallery')
    ) {
      isFieldTranslatable = true;
    }

    // Skip fields that are not translatable, not localized, or explicitly excluded
    if (
      !isFieldTranslatable ||
      !field.attributes.localized ||
      pluginParams.apiKeysToBeExcludedFromThisPlugin.includes(field.id)
    ) {
      continue;
    }

    // Skip if source locale value doesn't exist
    if (
      !(fieldValue &&
        typeof fieldValue === 'object' &&
        !Array.isArray(fieldValue) &&
        fieldValue[sourceLocale as keyof typeof fieldValue])
    ) {
      continue;
    }

    const sourceLocaleValue =
      fieldValue[sourceLocale as keyof typeof fieldValue];

    // Skip empty modular content arrays
    if (
      Array.isArray(sourceLocaleValue) &&
      (sourceLocaleValue as unknown[]).length === 0
    ) {
      continue;
    }

    // Use field label for UI display, falling back to API key if no label is defined
    const fieldLabel = field.attributes.label || field.attributes.api_key;

    // (no per-step toasts)
    // Process each target locale using a small pool to avoid bursts
    const jobs: Job[] = [];
    for (const locale of targetLocales) {
      // Check for cancellation before starting each locale
      if (options.checkCancellation?.()) {
        return; // Exit if translation was cancelled
      }
      
      // Notify translation start for this field-locale pair
      options.onStart?.(
        fieldLabel,
        locale,
        `${field.attributes.api_key}.${locale}`
      );

      // Prepare specialized prompt for the field type
      let fieldTypePrompt = 'Return the response in the format of ';
      const fieldPromptObject = fieldPrompt;
      const baseFieldPrompts = fieldPromptObject ? fieldPromptObject : {};

      // Structured and rich text fields use specialized prompts defined elsewhere
      if (fieldType !== 'structured_text' && fieldType !== 'rich_text') {
        fieldTypePrompt +=
          baseFieldPrompts[fieldType as keyof typeof baseFieldPrompts] || '';
      }

      // Set up streaming callbacks to provide real-time updates for this translation
      const streamCallbacks = {
        onStream: (chunk: string) => {
          options.onStream?.(fieldLabel, locale, chunk);
        },
        onComplete: () => {
          options.onComplete?.(fieldLabel, locale);
        },
        checkCancellation: options.checkCancellation,
        abortSignal: options.abortSignal
      };

      // Generate context about the record to improve translation quality
      const recordContext = generateRecordContext(ctx.formValues, sourceLocale);

      jobs.push(async () => {
        try {
          const translatedFieldValue = await translateFieldValue(
            (fieldValue as LocalizedField)[sourceLocale],
            pluginParams,
            locale,
            sourceLocale,
            fieldType,
            fieldTypePrompt,
            ctx.currentUserAccessToken as string,
            field.id,
            ctx.environment,
            streamCallbacks,
            recordContext
          );
          queueFieldWrite(
            `${field.attributes.api_key}.${locale}`,
            translatedFieldValue
          );
        } catch (err) {
          console.warn(`Field translation failed for ${field.attributes.api_key} → ${locale}:`, err);
          ctx.customToast?.({ type: 'warning', message: `Failed: ${field.attributes.label || field.attributes.api_key} → ${locale}` });
        }
        // silence incremental toast updates
      });
    }
    await runPool(jobs, 3);
    await flushWrites();
  }
  await flushWrites();
  ctx.customToast?.({ type: 'notice', message: 'Translations completed.' });
}
