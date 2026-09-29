import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { MAX_DATA_BYTES, MAX_DATA_ROWS, parseDataCsv, parseDataRows } from "./dataImport";

export async function parseDataUpload(buffer: Buffer, filename: string) {
  if (!buffer.length || buffer.length > MAX_DATA_BYTES) throw new Error("File must be between 1 byte and 5 MB");
  if (/\.csv$/i.test(filename)) return parseDataCsv(buffer.toString("utf8"));
  if (!/\.xlsx$/i.test(filename)) throw new Error("Upload a CSV or XLSX Data Export");
  // Check ZIP central-directory declared expansion before ExcelJS allocates XML.
  let expanded = 0, entries = 0;
  for (let i = 0; i + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(i) !== 0x02014b50) continue;
    entries++;
    expanded += buffer.readUInt32LE(i + 24);
    if (expanded > 25 * 1024 * 1024 || entries > 200) throw new Error("Expanded spreadsheet exceeds safe limits");
    i += 45 + buffer.readUInt16LE(i + 28) + buffer.readUInt16LE(i + 30) + buffer.readUInt16LE(i + 32);
  }
  if (!entries) throw new Error("Invalid XLSX ZIP directory");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  if (workbook.worksheets.length !== 1) throw new Error("Upload a workbook containing exactly one worksheet");
  const sheet = workbook.worksheets[0];
  if (sheet.rowCount > MAX_DATA_ROWS + 1 || sheet.columnCount > 200) throw new Error("Spreadsheet exceeds row or column limits");
  const rows: string[][] = [];
  sheet.eachRow(row => {
    const cells: string[] = [];
    for (let col = 1; col <= sheet.columnCount; col++) {
      const cell = row.getCell(col);
      if (cell.type === ExcelJS.ValueType.Formula) throw new Error("Spreadsheet formulas are not supported; export values only");
      cells.push(cell.text);
    }
    rows.push(cells);
  });
  return parseDataRows(rows, createHash("sha256").update(buffer).digest("hex"));
}