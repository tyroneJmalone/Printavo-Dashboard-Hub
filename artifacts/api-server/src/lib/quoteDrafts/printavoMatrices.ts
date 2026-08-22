export interface HubPricingMatrix {
  id: string;
  name: string;
  data: {
    xValues: Array<{ label: string }>;
  };
}

export interface HubDecorationMatrixSelection {
  id: string;
  location: string;
  matrixId: string | null;
  matrixColumnIndex: number | null;
}

export interface PrintavoPricingMatrixReference {
  id: string;
  name: string;
  columns: Array<{ id: string; columnName: string }>;
}

export interface ResolvedPrintavoPricingColumn {
  decorationId: string;
  pricingMatrixColumnId: string;
}

export class PrintavoMatrixResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrintavoMatrixResolutionError";
  }
}

function normalizedIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/*
 * The shop's legacy Breezy matrix is named simply "Embroidery"; Printavo's
 * current retail matrix has the operational tier suffix. Keep this as a name
 * alias rather than storing or hard-coding a Printavo ID, which can change.
 */
const PRINTAVO_MATRIX_NAME_ALIASES: Readonly<Record<string, string>> = {
  embroidery: "embroidery8",
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parsePrintavoPricingMatrixReferences(
  values: unknown[],
): PrintavoPricingMatrixReference[] {
  return values.map((value) => {
    const matrix = record(value);
    const id = matrix?.["id"];
    const name = matrix?.["name"];
    const rawColumns = matrix?.["columns"];
    if (
      typeof id !== "string" ||
      !id.trim() ||
      typeof name !== "string" ||
      !name.trim() ||
      !Array.isArray(rawColumns)
    ) {
      throw new PrintavoMatrixResolutionError(
        "The synced Printavo pricing-matrix reference data is incomplete. Run a reference sync before creating this quote.",
      );
    }
    const columns = rawColumns.map((rawColumn) => {
      const column = record(rawColumn);
      const columnId = column?.["id"];
      const columnName = column?.["columnName"];
      if (
        typeof columnId !== "string" ||
        !columnId.trim() ||
        typeof columnName !== "string" ||
        !columnName.trim()
      ) {
        throw new PrintavoMatrixResolutionError(
          "The synced Printavo pricing-matrix column data is incomplete. Run a reference sync before creating this quote.",
        );
      }
      return { id: columnId.trim(), columnName: columnName.trim() };
    });
    return { id: id.trim(), name: name.trim(), columns };
  });
}

export function resolvePrintavoPricingColumns(
  decorations: HubDecorationMatrixSelection[],
  hubMatrices: HubPricingMatrix[],
  printavoMatrices: PrintavoPricingMatrixReference[],
): ResolvedPrintavoPricingColumn[] {
  const hubMatrixById = new Map(hubMatrices.map((matrix) => [matrix.id, matrix]));

  return decorations.map((decoration) => {
    const hubMatrix = decoration.matrixId
      ? hubMatrixById.get(decoration.matrixId)
      : null;
    const hubColumn =
      hubMatrix && decoration.matrixColumnIndex !== null
        ? hubMatrix.data.xValues[decoration.matrixColumnIndex]
        : null;
    if (!hubMatrix || !hubColumn) {
      throw new PrintavoMatrixResolutionError(
        `${decoration.location}: select a valid Hub pricing matrix and column before creating the Printavo quote.`,
      );
    }

    const hubMatrixIdentity = normalizedIdentity(hubMatrix.name);
    const printavoMatrixIdentity =
      PRINTAVO_MATRIX_NAME_ALIASES[hubMatrixIdentity] ?? hubMatrixIdentity;
    const matrixMatches = printavoMatrices.filter(
      (matrix) => normalizedIdentity(matrix.name) === printavoMatrixIdentity,
    );
    if (matrixMatches.length === 0) {
      throw new PrintavoMatrixResolutionError(
        `${decoration.location}: Hub matrix "${hubMatrix.name}" has no matching Printavo pricing matrix.`,
      );
    }
    if (matrixMatches.length > 1) {
      throw new PrintavoMatrixResolutionError(
        `${decoration.location}: Hub matrix "${hubMatrix.name}" matches more than one Printavo pricing matrix.`,
      );
    }

    const hubColumnIdentity = normalizedIdentity(hubColumn.label);
    const columnMatches = matrixMatches[0].columns.filter(
      (column) => normalizedIdentity(column.columnName) === hubColumnIdentity,
    );
    if (columnMatches.length === 0) {
      throw new PrintavoMatrixResolutionError(
        `${decoration.location}: column "${hubColumn.label}" is missing from Printavo matrix "${matrixMatches[0].name}".`,
      );
    }
    if (columnMatches.length > 1) {
      throw new PrintavoMatrixResolutionError(
        `${decoration.location}: column "${hubColumn.label}" is duplicated in Printavo matrix "${matrixMatches[0].name}".`,
      );
    }

    return {
      decorationId: decoration.id,
      pricingMatrixColumnId: columnMatches[0].id,
    };
  });
}