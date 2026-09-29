/**
 * Printavo public workorder markup: table.table__invoice-line-items
 * (data-component="lig-table"), tbody > tr.line-item-detail.
 * Count only garment rows, not intervening asset/imprint/subtotal rows.
 */
export const WORKORDER_PRESENTATION_CSS = `
  table.table__invoice-line-items > tbody > tr:nth-child(odd of .line-item-detail) > td {
    background-color: #ffffff !important;
  }
  table.table__invoice-line-items > tbody > tr:nth-child(even of .line-item-detail) > td {
    background-color: #eeeeee !important;
  }
  table.table__invoice-line-items > tbody > tr.line-item-detail > td {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  .pq-reprint-banner {
    display: block !important; position: static !important;
    box-sizing: border-box; width: 100%;
    margin: 0 0 12px !important; padding: 10px 14px !important;
    border: 3px solid #111 !important; background: #eeeeee !important;
    color: #111 !important; font: bold 22px/1.3 Arial, sans-serif !important;
    text-align: center; break-inside: avoid; break-after: avoid;
    -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important;
  }
`;

export const REPRINT_BANNER_HTML = '<div class="pq-reprint-banner">UPDATED / REPRINT</div>';