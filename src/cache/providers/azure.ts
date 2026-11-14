import { openaiCache } from "./openai.js";

/** Azure's v1 Responses endpoint shares OpenAI's wire format and TTL rules.
 * Deployment aliases can identify the underlying model via promptCache.model.
 */
export const azureCache = openaiCache;
