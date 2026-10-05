/** Auto-print only: retain the upstream layout, using the supplied PDF's 7pt body. */
export const AUTO_PRINT_COMPACT_CSS = `
  body, body :is(div, p, span, td, th, li, a, strong, b, label) {
    font-family: Arial, sans-serif !important;
    font-size: 7pt !important;
    line-height: 1.3 !important;
  }
  body .pq-reprint-banner { font: bold 22px/1.3 Arial, sans-serif !important; }
  body, .page-content, table.table__invoice-line-items { font-size: 7pt !important; }
  .page-content { padding: 12px !important; }
  table.table__invoice-line-items td, table.table__invoice-line-items th,
  .line-item-goods-status-and-personalizations, .line-item-goods-status-and-personalizations .text-sm {
    font-size: 7pt !important; line-height: 1.3 !important;
  }
  .hub-purchase-note { font-size: 7pt !important; margin-left: 6px; }
  .hub-purchase-note + .hub-purchase-note { display: block; margin-left: 0; }
  .production-preview__wrapper, .production-file-preview__wrapper, .production-file-name {
    display: none !important;
  }
  .hub-customer-header { display: flex !important; align-items: flex-start; margin-top: 12px !important; }
  .hub-customer-header > .pdf-col-7 { width: 58.333333% !important; }
  .hub-customer-header > .pdf-col-5 { width: 41.666667% !important; }
  .hub-customer-header .addresses { display: flex !important; margin-top: 0 !important; }
  .hub-customer-header .addresses > div { width: 50% !important; overflow-wrap: anywhere; }
  .hub-customer-header .well { padding-top: 0 !important; }
`;

export interface PurchaseNote {
  lineId: string;
  text: string;
}

/** Apply striping to the entire product block, including its Goods Status row.
 * IDs come from Printavo markup; notes never match on product name alone. */
export function presentationScript(notes: PurchaseNote[]): string {
  return `(() => {
    const notes = ${JSON.stringify(notes)};
    // Move the original address nodes (including contact details), never recreate
    // or guess them. Only replace the known company column beside invoice meta.
    const layout = document.querySelector('.workorder-layout .page-content');
    const addresses = layout?.querySelector('.row.addresses');
    const company = layout?.querySelector('.invoice-logo-wrapper')?.closest('.pdf-col-7');
    const header = company?.parentElement;
    if (addresses && company && header?.querySelector('.invoice__top-meta')) {
      const oldColumn = addresses.parentElement;
      const oldRow = oldColumn?.parentElement;
      company.replaceChildren(addresses);
      header.classList.add('hub-customer-header');
      // Keep any invoice notes in the old row; remove only vacated space.
      oldColumn?.remove();
      if (oldRow && !oldRow.textContent.trim() && !oldRow.querySelector('img,svg,table')) {
        if (oldRow.previousElementSibling?.matches('hr')) oldRow.previousElementSibling.remove();
        oldRow.remove();
      }
    }
    document.querySelectorAll('table.table__invoice-line-items > tbody').forEach(body => {
      let index = -1;
      let lineId = null;
      for (const row of body.children) {
        if (row.matches('tr.line-item-detail')) {
          index++;
          lineId = row.getAttribute('data-line-item-id');
        } else if (!row.matches('tr.line-item-assets')) {
          lineId = null;
        }
        if (lineId) {
          for (const cell of row.children) {
            cell.style.setProperty('background-color', index % 2 ? '#eeeeee' : '#ffffff', 'important');
            cell.style.setProperty('print-color-adjust', 'exact', 'important');
            cell.style.setProperty('-webkit-print-color-adjust', 'exact', 'important');
          }
          const status = row.querySelector('.line-item-goods-status-and-personalizations .control-links');
          if (status && !status.querySelector('.hub-purchase-note')) {
            const matching = notes.filter(note => note.lineId === lineId);
            for (const note of matching.length ? matching : [{text: 'Purchasing details unavailable in Hub'}]) {
              const span = document.createElement('span');
              span.className = 'hub-purchase-note';
              span.textContent = ' | ' + note.text;
              status.appendChild(span);
            }
          }
        }
      }
    });
  })()`;
}