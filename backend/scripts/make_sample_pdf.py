"""Tiny dependency-free PDF writer (Helvetica text only), used for the sample
knowledge base and for tests. Run directly to regenerate sample_docs/returns_policy.pdf."""
from pathlib import Path


def make_pdf(pages: list[list[str]]) -> bytes:
    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    objects: list[bytes] = []
    n_pages = len(pages)
    page_ids = [3 + i * 2 for i in range(n_pages)]
    font_id = 3 + n_pages * 2
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{p} 0 R" for p in page_ids)
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode())
    for i, lines in enumerate(pages):
        content = "BT /F1 11 Tf 14 TL 56 780 Td " + " ".join(f"({esc(line)}) Tj T*" for line in lines) + " ET"
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 {font_id} 0 R >> >> "
            f"/Contents {page_ids[i] + 1} 0 R >>".encode()
        )
        objects.append(f"<< /Length {len(content)} >>\nstream\n{content}\nendstream".encode())
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for num, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{num} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


RETURNS_POLICY = [
    [
        "Lumenfield Outdoor Supply Co. - Returns and Refunds Policy",
        "FICTIONAL SAMPLE DOCUMENT - for demonstration only.",
        "Version 3.1, effective 1 March 2025.",
        "",
        "1. Return window",
        "Customers may return most items within 45 days of delivery.",
        "Items must include the original receipt or order number.",
        "Unopened items receive a full refund to the original payment method.",
        "",
        "2. Opened and used items",
        "Opened items in resalable condition are subject to a 10 percent restocking fee.",
        "Used camping stoves and fuel canisters cannot be returned for safety reasons.",
        "Clearance items marked Final Sale are not eligible for return.",
    ],
    [
        "3. Refund timing",
        "Approved refunds are processed within 7 business days of the item arriving",
        "at our Denver returns centre. Card issuers may take a further 3 to 5 days.",
        "",
        "4. International returns",
        "International customers pay return shipping unless the item arrived damaged.",
        "Customs duties paid on the original order are not refundable.",
        "",
        "5. Damaged or defective items",
        "Report damaged deliveries within 14 days with a photo of the damage.",
        "We send a prepaid return label and ship a replacement at no cost.",
    ],
]

if __name__ == "__main__":
    target = Path(__file__).resolve().parent.parent / "sample_docs" / "returns_policy.pdf"
    target.write_bytes(make_pdf(RETURNS_POLICY))
    print(f"Wrote {target}")
