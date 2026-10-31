/** Canonical SCA-only model alias and its exact resolved Pi catalog identity. */
export const SCA_MODEL_ALIAS = "deepseek-flash" as const;
export const SCA_MODEL_PROVIDER = "ollama" as const;
export const SCA_MODEL_ID = "deepseek-v4.1-flash:cloud" as const;
export const SCA_MODEL_OVERRIDE = `${SCA_MODEL_PROVIDER}/${SCA_MODEL_ID}` as const;
