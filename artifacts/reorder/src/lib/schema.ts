import { z } from "zod";

export const customerLookupSchema = z.object({
  searchType: z.enum(["email", "company"]),
  searchValue: z.string().min(1, "Required"),
}).refine(data => {
  if (data.searchType === "email") {
    return z.string().email().safeParse(data.searchValue).success;
  }
  return data.searchValue.length >= 2;
}, {
  message: "Enter a valid email or at least 2 characters for company",
  path: ["searchValue"]
});

export const SIZE_LABEL_MAP: Record<string, string> = {
  size_xs: "XS",
  size_s: "S",
  size_m: "M",
  size_l: "L",
  size_xl: "XL",
  size_2xl: "2XL",
  size_3xl: "3XL",
  size_4xl: "4XL",
  size_5xl: "5XL",
  size_6xl: "6XL",
  size_other: "Other",
  // add any others as needed, or fallback to the key
};
