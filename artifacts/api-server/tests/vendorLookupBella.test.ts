import test from "node:test";
import assert from "node:assert/strict";
import { SanMarClient, type SanMarProductEntry } from "@workspace/sanmar";
import { vendorLookup } from "../src/lib/purchasing/vendorLookup";

test("SanMar CVC alias is bounded to the exact style and Bella brand", async () => {
  const original = SanMarClient.prototype.getProductInfo;
  const old = [process.env.SANMAR_ACCOUNT_NUMBER, process.env.SANMAR_USERNAME, process.env.SANMAR_PASSWORD];
  process.env.SANMAR_ACCOUNT_NUMBER = process.env.SANMAR_USERNAME = process.env.SANMAR_PASSWORD = "test-only";
  const calls: string[] = [];
  let returnedBrand = "Bella + Canvas";
  SanMarClient.prototype.getProductInfo = async function (style) {
    calls.push(style.toUpperCase());
    return style.toUpperCase() === "BC3001CVC" ? [{
      style: "BC3001CVC", brandName: returnedBrand, productTitle: "CVC tee",
      catalogColor: "Ht Clay", size: "M", casePrice: 4.91, piecePrice: null,
      caseSalePrice: null, pieceSalePrice: null, saleEndDate: null,
      inventoryKey: "test", sizeIndex: 1, colorSwatchImage: null, colorProductImage: null,
    } as SanMarProductEntry] : [];
  };
  try {
    const result = await vendorLookup("sanmar", "3001CVC", { brandHint: "BELLA + CANVAS" });
    assert.equal(result.matchType, "exact");
    assert.equal(result.styleName, "BC3001CVC");
    assert.ok(calls.includes("BC3001CVC"));
    for (const brandHint of ["Gildan", undefined]) {
      calls.length = 0;
      assert.equal((await vendorLookup("sanmar", "3001CVC", { brandHint })).found, false);
      assert.ok(!calls.includes("BC3001CVC"));
    }
    calls.length = 0;
    await vendorLookup("sanmar", "3002CVC", { brandHint: "BELLA + CANVAS" });
    assert.ok(!calls.includes("BC3001CVC"));
    returnedBrand = "Other Brand";
    const mismatch = await vendorLookup("sanmar", "3001CVC", {
      brandHint: "BELLA + CANVAS", descriptionHint: "different cache context",
    });
    assert.equal(mismatch.found, false);
  } finally {
    SanMarClient.prototype.getProductInfo = original;
    ["SANMAR_ACCOUNT_NUMBER", "SANMAR_USERNAME", "SANMAR_PASSWORD"].forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i];
    });
  }
});