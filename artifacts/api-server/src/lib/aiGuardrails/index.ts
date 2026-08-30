/**
 * Shared AI guardrail modules — importable by every Hub AI surface
 * (context layer doors, Ask AI insights, quote extraction, correspondence
 * search). Deliberately NOT inside the context service's directory so
 * adopting them elsewhere never means importing "the context layer".
 */
export * from "./killSwitch";
export * from "./audit";
export * from "./rateLimit";
export * from "./citations";
