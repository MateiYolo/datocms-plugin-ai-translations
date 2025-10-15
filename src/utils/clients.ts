/**
 * Utilities for creating and configuring API clients
 */
import { buildClient } from '@datocms/cma-client-browser';

/**
 * Creates a DatoCMS client with the provided access token
 */
export function buildDatoCMSClient(accessToken: string, environment: string) {
  return buildClient({
    apiToken: accessToken,
    environment
  });
}

/**
 * Creates an OpenAI client with the provided API key
 */
// OpenAI client creation removed; we route through proxy now.
