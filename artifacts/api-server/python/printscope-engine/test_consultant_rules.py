"""Synthetic PDFs exercise the actual extractor; no customer artwork is edited.

Run: python -m unittest discover -s artifacts/api-server/python/printscope-engine
     -p test_consultant_rules.py -v
"""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pikepdf
from pikepdf import Array, Dictionary, Name, String

import detect as DT
import extract as EX
import raster as RS
import run as RUN
from consultant_extract import decode_text
from ink_names import swatch_parts


NEW_CODES = {
    "UNDERBASE_ROLE_AGREES", "FILL_STROKE_SAME_COLORANT", "INK_OVERLAP_NOT_TRAP",
    "SWATCH_LABEL_MANIFEST", "INK_CHANGE_DECLARED", "IMAGE_MIN_DPI",
    "IMAGE_HARD_MIN_DPI", "IMAGE_NOT_RGB",
}
HELD_CODES = {
    "UNDERBASE_REQUIRED_DARK", "UNDERBASE_ABSENT_LIGHT",
    "PLATE_COUNT_MATCHES_ORDER", "PRINT_SIZE_VS_LOCATION",
}


def check(code, facts, ctx=None, **params):
    return DT.REGISTRY[code](facts, ctx or {}, DT.Params({"expected": json.dumps(params)}))


class PdfFixture:
    def __init__(self):
        self.pdf = pikepdf.Pdf.new()
        self.page = self.pdf.add_blank_page(page_size=(612, 792))
        self.resources = Dictionary(ColorSpace=Dictionary(), XObject=Dictionary(), Font=Dictionary())
        self.page.Resources = self.resources
        marks = self.pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String("Reg Marks & Info")))
        self.pdf.Root.OCProperties = Dictionary(OCGs=Array([marks]))
        self.resources.Properties = Dictionary(Marks=marks)
        self.resources.Font.F1 = Dictionary(Type=Name.Font, Subtype=Name.Type1,
                                           BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)

    def spot(self, key, name, rgb=(229, 6, 149), alternate=Name.DeviceRGB):
        values = [x / 255 for x in rgb]
        self.resources.ColorSpace[key] = Array([
            Name.Separation, Name("/" + name), alternate,
            Dictionary(FunctionType=2, Domain=Array([0, 1]),
                       C0=Array([0] * len(values)), C1=Array(values), N=1)])

    def image(self, key, w=300, h=300, space=Name.DeviceRGB, mask=False):
        image = self.pdf.make_stream(bytes([0]) * max(1, w * h))
        image.Type, image.Subtype = Name.XObject, Name.Image
        image.Width, image.Height = w, h
        image.BitsPerComponent = 1 if mask else 8
        if mask:
            image.ImageMask = True
        else:
            image.ColorSpace = space
        self.resources.XObject[key] = image
        return image

    def form(self, key, content, matrix=(1, 0, 0, 1, 0, 0), resources=None):
        form = self.pdf.make_stream(content.encode())
        form.Type, form.Subtype = Name.XObject, Name.Form
        form.BBox, form.Matrix = Array([0, 0, 612, 792]), Array(matrix)
        form.Resources = resources if resources is not None else self.resources
        self.resources.XObject[key] = form
        return form

    def facts(self, content):
        self.page.Contents = self.pdf.make_stream(content.encode())
        with tempfile.TemporaryDirectory(prefix="sepscope-synthetic-") as tmp:
            path = os.path.join(tmp, "synthetic.pdf")
            self.pdf.save(path)
            return EX.extract(path)


class ExtractionTests(unittest.TestCase):
    def test_underbase_name_authority_and_alternate(self):
        pdf = PdfFixture()
        pdf.spot("/U", "1-160-Under")
        pdf.spot("/R", "6-230-Rhodamine Red C")
        facts = pdf.facts("/U cs 1 scn 10 10 50 50 re f /R cs 1 scn 80 10 30 30 re f")
        self.assertEqual(check("UNDERBASE_ROLE_AGREES", facts)["status"], DT.PASS)
        self.assertFalse(facts["artboards"][0]["is_underbase"])  # mixed board, not a base plate
        pdf.resources.ColorSpace["/U"][3].C1 = Array([0, 0, 1])
        self.assertEqual(check("UNDERBASE_ROLE_AGREES", pdf.facts(""))["status"], DT.FLAG)
        del pdf.resources.ColorSpace["/U"]
        self.assertEqual(check("UNDERBASE_ROLE_AGREES", pdf.facts(""))["status"], DT.NOT_APPLICABLE)

    def test_underbase_duplicate_tolerance_and_unsupported_transform(self):
        pdf = PdfFixture()
        pdf.spot("/U", "1-160-Under", (233, 10, 153))
        self.assertEqual(check("UNDERBASE_ROLE_AGREES", pdf.facts(""))["status"], DT.PASS)
        self.assertEqual(check("UNDERBASE_ROLE_AGREES", pdf.facts(""), rgb_abs=3)["status"], DT.FLAG)
        pdf.resources.ColorSpace["/U"][3].FunctionType = 4
        self.assertEqual(check("UNDERBASE_ROLE_AGREES", pdf.facts(""))["status"], DT.CANNOT_EVALUATE)
        pdf.spot("/U2", "2-160-Under")
        self.assertEqual(check("UNDERBASE_ROLE_AGREES", pdf.facts(""))["status"], DT.FLAG)

    def test_cmyk_and_gray_alternate_conversions(self):
        pdf = PdfFixture()
        pdf.spot("/U", "1-160-Under")
        pdf.resources.ColorSpace["/U"][2] = Name.DeviceCMYK
        pdf.resources.ColorSpace["/U"][3].C1 = Array([26 / 255, 249 / 255, 106 / 255, 0])
        self.assertEqual(check("UNDERBASE_ROLE_AGREES", pdf.facts(""))["status"], DT.PASS)
        pdf.resources.ColorSpace["/U"][2] = Name.DeviceGray
        pdf.resources.ColorSpace["/U"][3].C1 = Array([.5])
        facts = pdf.facts("")
        self.assertEqual(facts["artboards"][0]["colorant_details"][0]["rgb"], [128, 128, 128])
        self.assertEqual(check("UNDERBASE_ROLE_AGREES", facts)["status"], DT.FLAG)

    def test_paired_fill_stroke_and_zero_ink_choke_exclusion(self):
        pdf = PdfFixture()
        pdf.spot("/Blue", "5-230-Blue 286 C")
        pdf.spot("/Gray", "6-230-Gray 432")
        pdf.spot("/All", "All")
        facts = pdf.facts("""
            /Blue cs 1 scn /Gray CS 1 SCN .1 w 10 10 40 40 re B
            60 10 40 40 re B
            0 0 0 0 K .75 w 10 60 40 40 re B
            /All CS 1 SCN 60 60 40 40 re B
            /Blue CS 1 SCN 10 110 40 40 re B
            /Gray CS 1 SCN 60 110 40 40 re f
            60 160 40 40 re S
        """)
        result = check("FILL_STROKE_SAME_COLORANT", facts)
        self.assertEqual(result["status"], DT.FLAG)
        self.assertEqual(len(result["data"]["mismatches"]), 2)
        self.assertEqual(result["data"]["mismatches"][0]["w"], .1)
        self.assertEqual(len(facts["artboards"][0]["fill_stroke_pairs"]), 5)

    def test_choke_colour_state_restores_across_forms_and_q(self):
        pdf = PdfFixture()
        pdf.spot("/Blue", "1-230-Blue")
        pdf.form("/Form", "/Blue cs 1 scn 10 10 20 20 re B")
        facts = pdf.facts("0 0 0 0 K q 1 0 0 0 K /Form Do Q /Form Do")
        pairs = facts["artboards"][0]["fill_stroke_pairs"]
        self.assertFalse(pairs[0]["is_choke"])
        self.assertTrue(pairs[1]["is_choke"])
        self.assertEqual(len(check("FILL_STROKE_SAME_COLORANT", facts)["data"]["mismatches"]), 1)
        only_choke = pdf.facts("/DeviceCMYK CS 0 0 0 0 SCN /Form Do")
        self.assertEqual(check("FILL_STROKE_SAME_COLORANT", only_choke)["status"], DT.NOT_APPLICABLE)
        pdf.resources.ColorSpace.Knockout = Name.DeviceCMYK
        alias_choke = pdf.facts("/Knockout CS 0 0 0 0 SCN /Form Do")
        self.assertEqual(check("FILL_STROKE_SAME_COLORANT", alias_choke)["status"], DT.NOT_APPLICABLE)
        black_stroke = pdf.facts("/Knockout CS /Form Do")
        self.assertEqual(check("FILL_STROKE_SAME_COLORANT", black_stroke)["status"], DT.FLAG)

    def test_nested_accumulated_rotated_nonuniform_image_ctm(self):
        pdf = PdfFixture()
        pdf.image("/Im", 600, 300)
        inner = pdf.form("/Inner", "q 72 0 0 72 0 0 cm /Im Do Q",
                         matrix=(2, 0, 0, 1, 0, 0))
        outer_resources = Dictionary(XObject=Dictionary(Inner=inner))
        pdf.form("/Outer", "/Inner Do", matrix=(1, 0, 0, 2, 0, 0), resources=outer_resources)
        facts = pdf.facts("q 0 1 -1 0 500 0 cm /Outer Do Q q 72 0 0 72 0 0 cm /Im Do Q")
        images = facts["artboards"][0]["image_placements"]
        self.assertEqual(len(images), 2)
        self.assertAlmostEqual(images[0]["dpi_x"], 300)
        self.assertAlmostEqual(images[0]["dpi_y"], 150)
        self.assertAlmostEqual(images[1]["effective_dpi"], 300)
        self.assertEqual(check("IMAGE_HARD_MIN_DPI", facts)["status"], DT.FAIL)
        self.assertEqual(check("IMAGE_MIN_DPI", facts)["status"], DT.NOT_APPLICABLE)

    def test_palette_icc_calrgb_separation_devicen_and_masks(self):
        pdf = PdfFixture()
        profile = pdf.pdf.make_stream(b"synthetic profile; /N is the extraction fact")
        profile.N = 3
        pdf.spot("/Spot", "1-230-Blue")
        spot = pdf.resources.ColorSpace["/Spot"]
        spaces = [Name.DeviceRGB, Array([Name.CalRGB, Dictionary(WhitePoint=Array([1, 1, 1]))]),
                  Array([Name.Indexed, Name.DeviceRGB, 0, String(bytes([0, 0, 0]))]),
                  Array([Name.ICCBased, profile]), spot,
                  Array([Name.DeviceN, Array([Name("/1-230-Blue")]), Name.DeviceRGB, spot[3]]),
                  Name.DeviceGray]
        for i, space in enumerate(spaces):
            pdf.image(f"/I{i}", space=space)
        mask = pdf.image("/Mask", mask=True)
        soft = pdf.pdf.make_stream(bytes(300 * 300))
        soft.Subtype, soft.Width, soft.Height = Name.Image, 300, 300
        soft.ColorSpace, soft.BitsPerComponent = Name.DeviceGray, 8
        pdf.resources.XObject["/I0"].SMask = soft
        pdf.resources.XObject["/I0"].Mask = mask
        facts = pdf.facts("72 0 0 72 0 0 cm " + " ".join(f"/I{i} Do" for i in range(7)) + " /Mask Do")
        self.assertEqual(facts["artboards"][0]["images"], 8)  # soft mask not artwork
        result = check("IMAGE_NOT_RGB", facts)
        self.assertEqual(result["status"], DT.FAIL)
        self.assertEqual(len(result["data"]["images"]), 4)
        non_rgb = pdf.facts("72 0 0 72 0 0 cm /I4 Do /I5 Do /I6 Do /Mask Do")
        self.assertEqual(check("IMAGE_NOT_RGB", non_rgb)["status"], DT.PASS)
        only_mask = pdf.facts("7200 0 0 7200 0 0 cm /Mask Do")
        for code in ("IMAGE_MIN_DPI", "IMAGE_HARD_MIN_DPI", "IMAGE_NOT_RGB"):
            self.assertEqual(check(code, only_mask)["status"], DT.NOT_APPLICABLE)

    def test_alias_indexed_icc_space_and_singular_placement(self):
        pdf = PdfFixture()
        profile = pdf.pdf.make_stream(b"")
        profile.N = 3
        pdf.resources.ColorSpace.Alias = Array([Name.Indexed, Array([Name.ICCBased, profile]),
                                               0, String(bytes([0, 0, 0]))])
        pdf.image("/Im", space=Name.Alias)
        facts = pdf.facts("0 0 0 72 0 0 cm /Im Do")
        self.assertEqual(check("IMAGE_NOT_RGB", facts)["status"], DT.FAIL)
        self.assertEqual(check("IMAGE_HARD_MIN_DPI", facts)["status"], DT.CANNOT_EVALUATE)

    def test_malformed_image_measurement_is_not_silently_absent(self):
        pdf = PdfFixture()
        image = pdf.image("/Im")
        image.Width = Name.Invalid
        facts = pdf.facts("/Im Do")
        self.assertEqual(facts["artboards"][0]["images"], 1)
        self.assertIn("extraction_error", facts["artboards"][0]["image_placements"][0])
        self.assertEqual(check("IMAGE_HARD_MIN_DPI", facts)["status"], DT.CANNOT_EVALUATE)
        self.assertEqual(check("IMAGE_NOT_RGB", facts)["status"], DT.CANNOT_EVALUATE)

    def test_real_text_manifest_and_tolerant_separator(self):
        pdf = PdfFixture()
        pdf.spot("/Blue", "1-230-Blue 646 C")
        pdf.spot("/Gold", "5-230-Gold 110 C")
        content = """/Blue cs 1 scn 10 10 50 50 re f
            /OC /Marks BDC BT /F1 12 Tf 1 0 0 1 100 700 Tm
            (1 -- 230 -- Blue 646 C) Tj 0 -16 Td
            [(5-230-) 15 (Gold 110 C)] TJ ET EMC"""
        facts = pdf.facts(content)
        result = check("SWATCH_LABEL_MANIFEST", facts)
        self.assertEqual(result["status"], DT.FLAG)
        self.assertEqual(result["data"]["missing"], {"painted": ["gold 110 c"]})
        facts = pdf.facts(content + " /Gold cs 1 scn 70 10 50 50 re f")
        self.assertEqual(check("SWATCH_LABEL_MANIFEST", facts)["status"], DT.PASS)
        self.assertEqual(check("SWATCH_LABEL_MANIFEST", pdf.facts(""))["status"], DT.CANNOT_EVALUATE)

    def test_tounicode_composite_font_in_form(self):
        pdf = PdfFixture()
        pdf.spot("/Blue", "1-230-Blue")
        # A subset font whose character IDs are not ASCII proves ToUnicode is
        # actually used rather than accidentally decoding the source bytes.
        label = "1 -- 230 -- Blue"
        mapping = "\n".join(f"<{i:04X}> <{ord(ch):04X}>" for i, ch in enumerate(label, 1))
        cmap = pdf.pdf.make_stream(
            f"begincmap\n{len(label)} beginbfchar\n{mapping}\nendbfchar\nendcmap".encode())
        pdf.resources.Font.F1 = Dictionary(Type=Name.Font, Subtype=Name.Type0,
                                          Encoding=Name("/Identity-H"), ToUnicode=cmap)
        raw = "".join(f"{i:04X}" for i in range(1, len(label) + 1))
        pdf.form("/Text", f"/OC /Marks BDC BT /F1 12 Tf <{raw}> Tj ET EMC")
        facts = pdf.facts("/Blue cs 1 scn 10 10 50 50 re f /Text Do")
        self.assertEqual(facts["artboards"][0]["label_text_runs"][0]["text"], label)
        self.assertEqual(check("SWATCH_LABEL_MANIFEST", facts)["status"], DT.PASS)
        del pdf.resources.Font.F1["/ToUnicode"]
        self.assertEqual(check("SWATCH_LABEL_MANIFEST", pdf.facts("/Text Do"))["status"], DT.CANNOT_EVALUATE)

    def test_tounicode_range_forms_and_unmapped_glyph(self):
        pdf = PdfFixture()
        font = Dictionary(ToUnicode=pdf.pdf.make_stream(b"""
            2 beginbfrange
            <01> <03> <0041>
            <04> <05> [<0020> <D83DDE00>]
            endbfrange
        """))
        text, error = decode_text([String(bytes([1, 2, 3, 4, 5]))], "Tj", font)
        self.assertEqual((text, error), ("ABC \U0001f600", None))
        self.assertIsNotNone(decode_text([String(bytes([9]))], "Tj", font)[1])


class DetectorTests(unittest.TestCase):
    def test_compound_names_are_not_ink_changes(self):
        names = ["All", "1-160&10-230-White", "1-160&10-160-White&Navy 289",
                 "1-160 & 10-160-White & Navy 289", "5-200-Grey 429 & Yellow 121"]
        result = check("INK_CHANGE_DECLARED", {"all_inks": names})
        self.assertEqual(result["status"], DT.INFO)
        self.assertEqual(result["data"]["changes"], [{
            "swatch": names[-1], "head": "5", "inks": ["Grey 429", "Yellow 121"]}])
        self.assertEqual(check("INK_CHANGE_DECLARED", {"all_inks": names[:-1]})["status"], DT.NOT_APPLICABLE)
        self.assertEqual(swatch_parts("1-110 Under"), ("1-110", "Under"))

    def test_dpi_boundaries_and_per_image_dedup(self):
        facts = {"artboards": [{"index": 1, "images": 5, "image_placements": [
            {"name": str(dpi), "effective_dpi": dpi} for dpi in (199, 200, 299, 300, 600)]}]}
        table = [{"code": "IMAGE_MIN_DPI", "severity": "flag", "expected": '{"min":300}'},
                 {"code": "IMAGE_HARD_MIN_DPI", "severity": "fail", "expected": '{"min":200}'}]
        result = {r["code"]: r for r in DT.evaluate(facts, {}, table)}
        self.assertEqual([r["effective_dpi"] for r in result["IMAGE_MIN_DPI"]["data"]["images"]], [200, 299])
        self.assertEqual([r["effective_dpi"] for r in result["IMAGE_HARD_MIN_DPI"]["data"]["images"]], [199])
        table[1]["expected"] = '{"min":250}'
        result = {r["code"]: r for r in DT.evaluate(facts, {}, table)}
        self.assertEqual([r["effective_dpi"] for r in result["IMAGE_MIN_DPI"]["data"]["images"]], [299])
        table[1]["enabled"] = "false"
        result = DT.evaluate(facts, {}, table)[0]
        self.assertEqual(len(result["data"]["images"]), 3)  # no hidden hard-fail rule

    def test_no_rasters_and_legacy_missing_facts(self):
        for code in ("IMAGE_MIN_DPI", "IMAGE_HARD_MIN_DPI", "IMAGE_NOT_RGB"):
            self.assertEqual(check(code, {"artboards": [{"index": 1, "images": 0}]})["status"], DT.NOT_APPLICABLE)
            self.assertEqual(check(code, {"artboards": [{"index": 1, "images": 1}]})["status"], DT.CANNOT_EVALUATE)

    def test_overlap_info_cap_in_old_snapshot_and_gradient_suppression(self):
        facts = {"artboards": [{"index": 1, "inks": ["a", "b"], "shadings": 0}]}
        ctx = {"ink_overlaps": [{"artboard": 1, "inks": ["a", "b"], "max_width_pt": 2.4}]}
        for severity in ("flag", "fail", "info"):
            row = DT.evaluate(facts, ctx, [{"code": "INK_OVERLAP_NOT_TRAP", "severity": severity}])[0]
            self.assertEqual((row["status"], row["severity"]), (DT.INFO, "info"))
            self.assertEqual(row["data"]["wide_count"], 1)
        self.assertEqual(check("INK_OVERLAP_NOT_TRAP", facts, ctx, max=3)["data"]["wide_count"], 0)
        self.assertEqual(check("INK_OVERLAP_NOT_TRAP", facts)["status"], DT.CANNOT_EVALUATE)
        facts["artboards"][0]["shadings"] = 1
        self.assertEqual(check("INK_OVERLAP_NOT_TRAP", facts, ctx)["status"], DT.CANNOT_EVALUATE)

    def test_overlap_edt_units_all_exclusion_and_missing_plate(self):
        mask = np.zeros((20, 20), bool)
        mask[5:15, 5:15] = True
        with patch.object(RS, "plates", return_value={"a": mask, "b": mask, "All": np.ones_like(mask)}) as render:
            result = RS.ink_overlaps("read-only.pdf", 2, ["a", "b", "All", "1-160-Under"], dpi=200)
            self.assertEqual(len(result), 1)
            self.assertAlmostEqual(result[0]["max_width_pt"], 3.6)
            self.assertEqual(result[0]["overlap_px"], 100)
            render.assert_called_once_with("read-only.pdf", 2, 200)
            with self.assertRaisesRegex(ValueError, "unavailable"):
                RS.ink_overlaps("read-only.pdf", 2, ["a", "missing"])

    def test_overlap_real_pdf_raster(self):
        pdf = PdfFixture()
        pdf.spot("/A", "1-230-Blue")
        pdf.spot("/B", "2-230-Red", (255, 0, 0))
        pdf.resources.ExtGState = Dictionary(OP=Dictionary(OP=True, op=True, OPM=1))
        # Actual tiffsep integration: intentional overprint preserves both
        # separations across a 10pt-wide intersection.
        pdf.page.Contents = pdf.pdf.make_stream(
            b"/OP gs /A cs 1 scn 100 100 30 30 re f /B cs 1 scn 120 100 30 30 re f")
        with tempfile.TemporaryDirectory(prefix="sepscope-raster-test-") as tmp:
            path = os.path.join(tmp, "overlap.pdf")
            pdf.pdf.save(path)
            facts = EX.extract(path)
            ctx = RUN.build_ctx(path, facts)
        self.assertNotIn("ink_overlap_error", ctx)
        result = check("INK_OVERLAP_NOT_TRAP", facts, ctx)
        self.assertEqual(result["status"], DT.INFO)
        self.assertEqual(result["data"]["wide_count"], 1)
        self.assertGreater(result["data"]["overlaps"][0]["max_width_pt"], 9)

    def test_held_rules_still_missing_and_choke_disabled(self):
        self.assertTrue(NEW_CODES <= set(DT.REGISTRY))
        self.assertFalse(HELD_CODES & set(DT.REGISTRY))
        table = RUN.load_table()
        self.assertEqual(next(r for r in table if r["code"] == "CHOKE_SAFE_FOR_DETAIL")["enabled"], "false")


if __name__ == "__main__":
    unittest.main()