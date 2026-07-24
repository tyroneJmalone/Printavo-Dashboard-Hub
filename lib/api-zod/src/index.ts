export * from "./generated/api";
export * from "./generated/types";

// getCustomerProfile has both path params (zod schema in ./generated/api) and
// query params (TS type in ./generated/types), and orval names them both
// "GetCustomerProfileParams". Resolve the ambiguity: the bare name is the zod
// schema; the query-params type is re-exported under an aliased name.
export { GetCustomerProfileParams } from "./generated/api";
export type { GetCustomerProfileParams as GetCustomerProfileQueryParamsType } from "./generated/types";

// Same orval allOf collision for the insights response schemas: zod schema
// (./generated/api) and TS type (./generated/types) share the name. Bare
// name = zod schema; the TS types get aliased re-exports.
export { AskInsightsResponse, RunInsightsPresetResponse } from "./generated/api";
export type {
  AskInsightsResponse as AskInsightsResponseType,
  RunInsightsPresetResponse as RunInsightsPresetResponseType,
} from "./generated/types";
