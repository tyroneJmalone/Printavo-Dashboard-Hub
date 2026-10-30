# Future enhancement: Collection-based client sales sheets

## Status and purpose
**Deferred — discussion recorded October 30, 2026. Not scheduled or approved for implementation.**

The user wants this substantial feature recorded on its own page in the future
enhancement log, with the full discussion preserved. Logging does not authorize
building the feature, generating paid images, training a model, connecting
services, or sending customer emails.

The proposed feature belongs in **Sales → Collections**: create a one-page sales
presentation using products in an existing Collection and chosen client artwork
or logos, within a template containing Mint branding and information.

User-requested capabilities to revisit:
- Products drawn from a created Collection.
- Selected client logos/artwork and actual supplied product images.
- A predetermined Mint-branded page template.
- Automated repetitive sizing and placement without creative reinterpretation.
- Occasional batch creation.
- A downloadable file.
- Eventually, direct email delivery from Hub.
- A representative example sheet as a reference for theme/layout.

## How the discussion evolved
The initial question was whether AI could process product and artwork inputs,
create product renderings, and assemble sales presentations. The user suggested
creating an example to help train AI on the intended theme/layout.

The initial recommendation separated accurate product mockups from consistent
page assembly. Asking generative AI to create the entire sheet as one image
would make text, logos, pricing, layout, and editing less dependable.

The user then clarified that the real requirement could be much more controlled:
provide actual product images and logos and have them sized and placed on a
predetermined sheet, with no creative liberties.

The refined recommendation is **deterministic template assembly**, not mandatory
generative AI. Exact supplied artwork should be retained. AI remains an optional
assistant where it adds value, not a prerequisite for repetitive layout work.
This is a proposed technical approach, not an implementation approval.

## Two distinct placement problems
### A. Place images and text on the sales sheet
Use fixed template rules for:
- Product-image boxes and their arrangement.
- Mint branding, customer-logo position, header and footer.
- Product names, descriptions, and optional approved pricing.
- Margins, spacing, maximum dimensions, and image fitting.

Fit supplied images into their boxes while preserving proportions. Keep text
as editable content rather than lettering baked into an AI-generated image.
Generate the finished PDF from the structured layout. Neither model training
nor generative AI is needed for this part.

### B. Place client artwork onto product photographs
This is a separate mockup operation, not merely page layout. Proposed reusable
decoration areas include:
- T-shirt: full front or left chest.
- Polo: left chest.
- Cap: front panel.
- Bag: center panel.

Overlay the actual logo with adjustable position and size. Controlled image
composition can shape the artwork to suit the product image without asking AI
to redraw it.

Vendor photos vary in angle, crop, pose, and garment position. One universal
left-chest coordinate will not reliably fit every image. Save staff-approved
placements per product image/view for reuse. AI could optionally suggest a
placement, but staff should confirm it before it becomes a reusable preset.

With approved placements, later sheets and batches become repetitive assembly
and do not require a new paid AI image generation each time.

## Proposed staff workflow
1. Open a Collection and choose **Create Sales Sheet**.
2. Select the customer and the products to feature.
3. Choose exact product colors and views.
4. Select client logos/artwork from their linked artwork folder or upload them.
5. If creating decorated mockups, select placement for each product.
6. Choose a Mint-branded template.
7. Automatically populate the page and generate any requested mockups.
8. Review and adjust image placement, wording, product order, and optional pricing.
9. Save an editable sheet and download it.
10. In a later phase, preview recipients/message and send the approved version.

Initial code inspection found catalog product details and imagery available
through Collections, which provides a starting point. That does not establish
that every selected style/color/view has a suitable image; coverage and source
image quality still need verification during implementation.

## Template and reference-sheet approach
A real example would be valuable for defining:
- Page layout and product count.
- Mint fonts, colors, branding, footer, and contact information.
- Product-image scale, decoration positioning, and customer-logo treatment.
- Writing guidelines and the desired presentation tone.
- Reference images/instructions if optional AI image work is used.

An approved example should become a reusable template and rules, rather than
immediately pursuing custom model training. This is more controllable and
reproducible for the stated requirement. No model or provider has been selected.

Suggested starting composition, not an approved design:
- Three to six products per page.
- Mint branding and a client-specific heading.
- Large decorated product images.
- Style name, selected color, and one or two selling points.
- Optional approved pricing.
- Contact information and a brief call to action.

If the Collection is larger, select a subset or split it into separate sheets;
do not make the page unreadable by shrinking every product. Exact page size,
orientation, templates, and maximum product count remain undecided.

## Optional AI and accuracy boundaries
AI could help with short descriptions, client-specific introductory copy,
placement suggestions, alternate presentation styles, or more realistic and
creative product scenes. Those are optional extensions, not a requirement to
generate the basic sheet.

Generative models can alter logos, misspell lettering, change garment details,
or depict inaccurate colors. Prefer actual vendor images for the selected
style/color and original supplied logos. Any AI-generated realism or creative
scene needs staff review.

Treat the sheet as a **sales concept, not a final production proof**. Do not
represent visual mockup positioning as verified production dimensions.
Pricing should come from approved inputs, not invented model output.

## Batch scenarios and safeguards
Distinguish these possible batch needs:
- One Collection, multiple clients, with different client logos.
- Several Collections for one client.
- Multiple versions of a single sheet.

Retain selected products, artwork, template version, and approval state for each
generated sheet. Support per-item failures and retries rather than restarting
the entire batch. Estimate paid generation costs before starting any optional
AI work. Fixed-template composition avoids unnecessary per-sheet AI generation.

Batch generation is not authorization to send customer emails.

## Downloads, saved versions, and eventual email
Recommended output options:
- PDF for printing, downloading, and emailing.
- PNG/JPG as a convenient preview.
- Saved editable sheet data in Hub so changes do not require starting over.

Email is a later phase: recipient verification, message/attachment preview,
explicit send approval, and a record of exactly which approved sheet version
was sent. Do not automatically email generated batches.

## Proposed sequencing and open questions
Recommended next step when the user returns: create one representative sheet
using a real Collection and client logo. Approve layout and product accuracy
before building automation around it.

Proposed phases:
1. Reference example, template rules, and exact-image placement approach.
2. Single-sheet creation, review/editing, saved sheet, and PDF download.
3. Reusable product-view decoration presets and batch generation as needed.
4. Direct email and optional AI assistance.

Still to decide: representative Collection/client; page size/orientation;
product limits and overflow handling; placement-editing controls; approved
pricing source and display; template management; batch scope and limits;
email workflow/provider; roles/permissions; image availability and suitability.
No template, reference sheet, batch size, provider, or delivery workflow has
been selected. Preserve these as future decisions rather than implied approvals.
