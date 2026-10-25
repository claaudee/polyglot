/**
 * Which roles of a Messages request get translated. Everything else —
 * system, tool_use, tool_result, thinking, signatures — is never touched.
 */
export interface Scopes {
  /** User text → model language. */
  readonly user: boolean;
  /** Translated assistant history → the model's exact original. */
  readonly assistant: boolean;
}

export const DEFAULT_SCOPES: Scopes = { user: true, assistant: true };

export const mergeScopes = (overrides: Partial<Scopes> | undefined): Scopes => ({
  ...DEFAULT_SCOPES,
  ...overrides,
});
