import unittest
import numpy as np
from scipy import ndimage as ndi
import local_underbase as L
import detect as DT
import os
from unittest.mock import patch
import raster as RS


class LocalCoverageTests(unittest.TestCase):
    def art(self):
        m = np.zeros((400, 500), bool)
        m[20:240, 20:450] = True  # big correctly based artwork
        for x in range(40, 250, 30):
            m[300:320, x:x+12] = True
        return m

    def test_correct_and_normal_choke(self):
        m = self.art()
        self.assertEqual(L.measure(m, m), [])
        self.assertEqual(L.measure(m, ndi.binary_erosion(m, iterations=2)), [])

    def test_small_word_cannot_hide_in_large_art(self):
        m = self.art()
        b = m.copy()
        b[300:320, 40:250] = False
        r = L.measure(m, b)
        self.assertEqual(len(r), 7)
        self.assertTrue(all(x["status"] == "fail" for x in r))
        for v in r:
            self.assertGreaterEqual(v["bbox"][1], .75)
        b[300:320, 40:250] = m[300:320, 40:250]
        self.assertEqual(L.measure(m, b), [])

    def test_missing_interior_and_shift(self):
        m = self.art()
        b = m.copy()
        b[80:100, 80:100] = False
        self.assertTrue(any(r["status"] == "fail" for r in L.measure(m, b)))
        b = np.roll(m, 15, axis=1)
        self.assertTrue(L.measure(m, b))

    def test_uncertain_small_region(self):
        m = np.zeros((80, 80), bool)
        m[30:34, 30:35] = True
        self.assertEqual(L.measure(m, np.zeros_like(m))[0]["status"], "flag")

    def test_shape_mismatch(self):
        with self.assertRaises(ValueError):
            L.measure(np.zeros((2, 2)), np.zeros((3, 3)))

    def test_rule_fail_and_incomplete(self):
        r = DT.under_coverage({}, {"local_underbase":{"failCount":1}}, DT.Params({}))
        self.assertEqual(r["status"], DT.FAIL)
        r = DT.under_coverage({}, {"local_underbase":{"error":"unavailable"}}, DT.Params({}))
        self.assertEqual(r["status"], DT.CANNOT_EVALUATE)

    def test_deliberately_unbased_colour_and_multiple_boards(self):
        a = self.art()
        other = np.zeros_like(a)
        other[260:275, 350:380] = True
        facts = {"artboards":[
            {"index":1,"is_underbase":False,"inks":["Blue"],"label_text_runs":[]},
            {"index":2,"is_underbase":False,"inks":["Red"],"label_text_runs":[]},
            {"index":3,"is_underbase":True,"inks":["Under"]}]}
        def plates(src,page):
            return {1:{"Blue":a},2:{"Red":other},3:{"Under":a}}[page]
        with patch.object(RS,"plates",side_effect=plates), patch.object(RS,"info_bar_cut",return_value=0):
            r=L.inspect("",facts,RS)
        self.assertIsNone(r["error"])
        self.assertEqual(r["failCount"],0)
        self.assertTrue(r["notes"])

    @unittest.skipUnless(os.environ.get("SEPSCOPE_DEFECT_FIXTURE"), "Stored customer fixture is opt-in")
    def test_real_hardscape_and_corrected_mask(self):
        import extract as EX
        src=os.environ["SEPSCOPE_DEFECT_FIXTURE"]
        r=L.inspect(src,EX.extract(src),RS)
        self.assertIsNone(r["error"])
        self.assertEqual(r["failCount"],9)
        self.assertEqual(r["flagCount"],0)
        colour=RS.plates(src,1)["10-230-Blue 278"].copy()
        base=RS.plates(src,2)["1-160-Under"].copy()
        cut=RS.info_bar_cut({"10-230-Blue 278":colour},RS.text_rows_for(EX.extract(src)["artboards"][0]),RS.DPI)
        colour[:cut+1]=False
        base[:cut+1]=False
        # Simulate restoring just the nine missing letters, not replacing
        # the entire underbase. This is a mask test, not an edited AI file.
        h,w=colour.shape
        for region in r["regions"]:
            x,y,bw,bh=region["bbox"]
            ys=slice(max(0,round(y*h)-5),min(h,round((y+bh)*h)+5))
            xs=slice(max(0,round(x*w)-5),min(w,round((x+bw)*w)+5))
            base[ys,xs] |= colour[ys,xs]
        self.assertEqual(L.measure(colour,base),[])


if __name__ == "__main__":
    unittest.main()
