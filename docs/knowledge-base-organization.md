# Knowledge Base organization and handling

Approved project direction, September 25, 2026.

## Two independent labels

Every knowledge entry has a topical category and a usage classification.
The category answers “Where would a teammate look for this?” The usage
classification answers “How may this information be used?”

The agreed team-library categories are:

- Policies & Employee Handbook
- Training & SOPs
- Order & Production Guidelines
- Sales Resources & FAQs
- Branding & Marketing

Initially, all five categories default to **Internal Operational Knowledge**.
Keep existing categories and entries intact; do not automatically rewrite their
categories, classifications, or approval status.

**Why:** A subject such as sales, pricing, or branding can contain both public
facts and internal instructions. Organizing information must not silently expand
customer or AI access.

## Usage classifications

| Classification | Meaning |
| --- | --- |
| Internal Operational Knowledge | Internal reference and authorized internal AI use; excluded from customer-facing knowledge retrieval. |
| Customer-Shareable | Facts deliberately approved for customer-facing use, including all relevant qualifications and exceptions. |
| Brand/Voice Guidance | Tone and writing-style guidance, not evidence for factual answers, policies, prices, or promises. |

Topic mappings suggest the classification for new entries. An editor can
deliberately override that suggestion. Mapping changes do not retroactively
reclassify existing entries. Existing custom mappings must be preserved.

## Adding and reviewing documents

1. Add or import content as a draft.
2. Choose a clear title and topical category.
3. Review the proposed usage classification and override it where appropriate.
4. Review the actual extracted content for completeness and readability,
   particularly for PDFs. Preserve short rules, exceptions, dates, and source
   references.
5. Approve only reviewed, applicable content for live AI retrieval.

Split mixed-audience documents into separate knowledge entries. For example,
customer artwork-submission requirements can be Customer-Shareable, while
internal exception-handling instructions remain Internal Operational Knowledge.
Do not mark a whole mixed document customer-shareable just to expose one section.

New imports remain drafts; live AI retrieval requires approval and applicable
effective/expiry dates. Editing AI-visible content or classification on an
approved entry requires re-approval. A staff playground may test drafts without
publishing them.

The importer may identify tone-only material as Brand/Voice Guidance; that does
not make factual material customer-shareable and does not bypass review.

## AI integration boundaries

- The consumer's permissions and the entry's explicit usage classification
  govern retrieval. A topical category is not an authorization boundary.
- Customer-facing knowledge tools retrieve approved, current Customer-Shareable
  entries only.
- Authorized internal tools may retrieve internal knowledge through their
  permitted tools/scopes. Do not assume every integration has internal access.
- Brand/Voice guidance is retrieved separately for writing style, never as
  support for factual claims.
- Search and category filters must narrow authorized results, not widen them.
- “Internal” is not a secure vault for confidential personnel records,
  credentials, or secrets.

## Examples

| Content | Topic category | Usage classification |
| --- | --- | --- |
| Employee attendance policy | Policies & Employee Handbook | Internal Operational Knowledge |
| Production-mistake handling instructions | Training & SOPs | Internal Operational Knowledge |
| Published artwork-submission requirements | Order & Production Guidelines | Customer-Shareable |
| Internal discount approval limits | Sales Resources & FAQs | Internal Operational Knowledge |
| Approved customer FAQ | Sales Resources & FAQs | Customer-Shareable |
| Friendly, direct writing instructions | Branding & Marketing | Brand/Voice Guidance |
| Approved service-description sales flyer | Branding & Marketing | Customer-Shareable |

## Team-facing library direction

Keep the full Knowledge Base management workspace in Settings. The separately
planned team-facing library uses the **same data**, not a duplicate store, and
provides browsing and search rather than duplicating management controls.

Start with a representative collection of frequently needed documents across
the five categories. Validate the library against that real content, then expand
the collection; uploading every document is not a prerequisite.

Search is part of the first team-library version:

- A prominent search box.
- Search within document/article content, not just titles.
- Matching excerpts in results.
- Category filters.
- Direct access to the source article or document.
- Approved, authorized content only.

Reliable ordinary search comes before an optional conversational AI interface.
The library should accommodate policies, the handbook, training manuals, SOPs,
FAQs, order guidelines, branding documents, and sales resources.