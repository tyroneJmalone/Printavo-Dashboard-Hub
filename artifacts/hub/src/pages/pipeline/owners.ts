// Pipeline owner choices are intentionally limited; All still shows all orders.
export const PIPELINE_OWNERS = ["Info", "Tommy", "Andrew", "Medina", "Tyler"].map(name => ({
  name,
  email: `${name.toLowerCase()}@mintprintworks.com`,
}));

export function normalizePipelineOwner(email: string | null | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return PIPELINE_OWNERS.find(owner => owner.email === normalized)?.email;
}
