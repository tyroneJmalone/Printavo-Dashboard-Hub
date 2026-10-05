"""Read-only layout proof. Does not connect to AutoPrint or a printer."""
import pymupdf as pdf

doc = pdf.open()
page = doc.new_page(width=612, height=792)
left, right = 30, 582
page.insert_text((left, 30), "DRAFT — illustrative PO line selection; not an actual processed PO", fontsize=8, color=(.4,.4,.4))
page.insert_text((left, 57), "Invoice #22787", fontsize=17, fontname="hebo")
page.insert_text((left, 77), "Mint Make Ups 2026 (NEW)", fontsize=11)
page.draw_line((left, 89), (right, 89), width=.7)

for x, y, label, value in [
    (36, 108, "PO #", "[PO number]"),
    (318, 108, "Order date", "[PO submission date]"),
    (36, 139, "Vendor", "[Vendor name]"),
    (318, 139, "Warehouse", "[Ordered-from warehouse]"),
]:
    page.insert_text((x, y), label, fontsize=8, fontname="hebo")
    page.insert_text((x, y + 14), value, fontsize=10)

page.draw_rect(pdf.Rect(left, 170, right, 191), color=None, fill=(.93,.93,.93))
for x, label in [(36,"Item / Style"),(180,"Color"),(439,"Size"),(543,"Qty")]:
    page.insert_text((x,184),label,fontsize=9,fontname="hebo")
for x, text in [(36,"BP36"),(180,"Oatmeal Heather"),(439,"Other"),(543,"1")]:
    page.insert_text((x,209),text,fontsize=10)

page.insert_text((36,233),"Line-item description",fontsize=8,fontname="hebo")
description = ("Port Authority - Port Authority Cozy Blanket. BP36\n\n"
               "#23115 IWP Merch\n"
               "Changed thread color after first one\n"
               "Pleaaw order from NJ")
remaining = page.insert_textbox(pdf.Rect(36,243,576,329),description,fontsize=10,lineheight=1.3)
assert remaining >= 0, "Description does not fit in the draft"
page.draw_line((left,332),(right,332),width=.6)
doc.save("exports/invoice-22787-po-slip-draft.pdf")
page.get_pixmap(matrix=pdf.Matrix(2,2),clip=pdf.Rect(0,0,612,354)).save("exports/invoice-22787-po-slip-draft.png")
