#!/usr/bin/env python3
"""Generate big printable QR labels (one per page) from the LIVE box tracker.

Pulls the stored station codes from the production API so the printed QRs are
exactly the codes the app already recognizes. Output: qr-labels-large.pdf
(letter pages: huge dimensions text, station name, ~5.5-inch QR, code text).

Run:  py make-qr-pdf.py
"""
import json
import re
import urllib.request

import qrcode
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

BASE = "https://asp-box-tracker-production.up.railway.app"
OUT = "qr-labels-large.pdf"


def api(action):
    req = urllib.request.Request(
        BASE + "/api",
        data=json.dumps({"action": action}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def box_length(dims):
    m = re.findall(r"\d+(?:\.\d+)?", dims or "")
    return float(m[0]) if m else float("inf")


def draw_qr(c, code_text, x, y, size):
    """Draw the QR as crisp vector squares at (x, y) lower-left, side `size`."""
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=2)
    qr.add_data(code_text)
    qr.make(fit=True)
    matrix = qr.get_matrix()
    n = len(matrix)
    cell = size / n
    c.setFillColorRGB(0, 0, 0)
    for row in range(n):
        for col in range(n):
            if matrix[row][col]:
                c.rect(x + col * cell, y + size - (row + 1) * cell, cell, cell,
                       stroke=0, fill=1)


def main():
    state = api("getState")
    areas = state["areas"]
    types = sorted(state["boxTypes"], key=lambda t: (box_length(t["dimensions"]), t["dimensions"]))
    codes = {(b["typeId"], b["areaId"]): b["barcode"] for b in state["barcodes"]}

    page_w, page_h = letter
    c = canvas.Canvas(OUT, pagesize=letter)
    pages = 0

    # Group by station so the stack is easy to hang: all of one area first.
    for area in areas:
        for t in types:
            code = codes.get((t["id"], area["id"]))
            if not code:
                continue
            # Dimensions — huge, top center
            c.setFont("Helvetica-Bold", 88)
            c.drawCentredString(page_w / 2, page_h - 110, t["dimensions"])
            # Station name
            c.setFont("Helvetica", 30)
            c.setFillColorRGB(0.25, 0.25, 0.25)
            c.drawCentredString(page_w / 2, page_h - 155, area["name"])
            c.setFillColorRGB(0, 0, 0)
            # QR — ~5.6 inches, centered
            qr_size = 400
            draw_qr(c, code, (page_w - qr_size) / 2, page_h - 185 - qr_size, qr_size)
            # Code text under the QR
            c.setFont("Helvetica", 18)
            c.setFillColorRGB(0.35, 0.35, 0.35)
            c.drawCentredString(page_w / 2, page_h - 185 - qr_size - 30, code)
            c.setFillColorRGB(0, 0, 0)
            c.showPage()
            pages += 1

    c.save()
    print(f"wrote {OUT}: {pages} pages "
          f"({len(types)} sizes x {len(areas)} stations)")


if __name__ == "__main__":
    main()
