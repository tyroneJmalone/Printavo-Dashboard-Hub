export * from "./generated/api";
export * from "./generated/types";

// getPrintavoOrderHistory has a path parameter plus query pagination params,
// and orval emits the same params name in both generated surfaces.
export { GetPrintavoOrderHistoryParams } from "./generated/api";
export type {
  GetPrintavoOrderHistoryParams as GetPrintavoOrderHistoryQueryParamsType,
} from "./generated/types";

// getOrderActivity also has path/query params and orval emits the same
// params name in both generated surfaces.
export { GetOrderActivityParams } from "./generated/api";
export type {
  GetOrderActivityParams as GetOrderActivityQueryParamsType,
} from "./generated/types";

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

// Artwork operations combine path and query parameters. Keep the generated
// path-param Zod schemas on the bare names and alias the query TS types.
export {
  BrowseCustomerArtworkParams,
  SearchCustomerArtworkParams,
  GetCustomerArtworkMetadataParams,
  GetCustomerArtworkTemporaryLinkParams,
  PickCustomerArtworkFolderParams,
} from "./generated/api";
export type {
  BrowseCustomerArtworkParams as BrowseCustomerArtworkQueryParamsType,
  SearchCustomerArtworkParams as SearchCustomerArtworkQueryParamsType,
  GetCustomerArtworkMetadataParams as GetCustomerArtworkMetadataQueryParamsType,
  GetCustomerArtworkTemporaryLinkParams as GetCustomerArtworkTemporaryLinkQueryParamsType,
  PickCustomerArtworkFolderParams as PickCustomerArtworkFolderQueryParamsType,
} from "./generated/types";

// PrintScope review history combines a job path parameter with pagination.
// Keep the path-param Zod schema bare and alias the generated query type.
export { ListPrintscopePilotReviewsParams } from "./generated/api";
export type {
  ListPrintscopePilotReviewsParams as ListPrintscopePilotReviewsQueryParamsType,
} from "./generated/types";

// Same collision for the chipply parse-email response (inline allOf for the
// nullable existingStore ref): bare name = zod schema; TS type aliased.
export { ParseChipplyEmailResponse } from "./generated/api";
export type { ParseChipplyEmailResponse as ParseChipplyEmailResponseType } from "./generated/types";

// Same collision for the chipply parse-file response (allOf refs for the
// nullable salesReport/existingStore): bare name = zod schema; TS type aliased.
export { ParseChipplyFileResponse } from "./generated/api";
export type { ParseChipplyFileResponse as ParseChipplyFileResponseType } from "./generated/types";
