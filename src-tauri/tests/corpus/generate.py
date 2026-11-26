#!/usr/bin/env python3
import io
import os
import random
import shutil
import subprocess
import tempfile

import pikepdf
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.colors import blue, red
from reportlab.lib.pagesizes import A4, A5, landscape, letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
PASSWORD = "corpus"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
LOREM = (
    "Le contrat prend effet à la date de signature. Les parties conviennent "
    "de ce qui suit, article par article, sans réserve ni condition."
)

def out(name):
    return os.path.join(HERE, name)

def run(*cmd):
    subprocess.run(cmd, check=True)

def text_doc(path, pages=3, sizes=(A4,), rotate=None):
    c = canvas.Canvas(path, pagesize=sizes[0], invariant=1)
    c.setTitle("Corpus text document")
    for i in range(pages):
        size = sizes[i % len(sizes)]
        c.setPageSize(size)
        if rotate and i in rotate:
            c.setPageRotation(rotate[i])
        c.setFont("Helvetica-Bold", 18)
        c.drawString(72, size[1] - 72, f"Page {i + 1}")
        c.setFont("Times-Roman", 11)
        y = size[1] - 110
        for line in range(20):
            c.drawString(72, y, f"{line + 1:02d}. {LOREM[: 60 + line]}")
            y -= 16
        c.showPage()
    c.save()

def classic_and_old_versions():
    tmp = out("_text.pdf")
    text_doc(tmp, pages=4, sizes=(A4, letter, landscape(A5)), rotate={2: 90})
    run("gs", "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.3", f"-sOutputFile={out('pdf13-ghostscript.pdf')}", tmp)
    shutil.copy(tmp, out("pdf14-mixed-sizes-rotated.pdf"))
    run("qpdf", "--object-streams=generate", "--force-version=1.5", tmp, out("pdf15-object-streams.pdf"))
    run("qpdf", "--linearize", tmp, out("linearized.pdf"))
    run("qpdf", "--force-version=2.0", tmp, out("pdf20.pdf"))
    os.remove(tmp)

def incremental_updates():
    tmp = out("_inc.pdf")
    text_doc(tmp, pages=2)
    pdf = pikepdf.open(tmp)
    pdf.docinfo["/Title"] = "Revision 1"
    pdf.save(out("incremental-updates.pdf"), static_id=True)
    pdf.close()
    os.remove(tmp)
    with open(out("incremental-updates.pdf"), "rb") as f:
        data = f.read()
    prev = int(data[data.rindex(b"startxref") + 9:].split()[0])
    doc = pikepdf.open(io.BytesIO(data))
    size = len(doc.objects) + 1
    root = doc.trailer.Root.objgen
    doc.close()
    obj_num = size
    body = f"\n{obj_num} 0 obj\n<< /Title (Revision 2) /Producer (corpus) >>\nendobj\n".encode()
    obj_at = len(data) + 1
    xref_at = len(data) + len(body)
    xref = (
        f"xref\n0 1\n0000000000 65535 f \n{obj_num} 1\n{obj_at:010d} 00000 n \n"
        f"trailer\n<< /Size {obj_num + 1} /Root {root[0]} {root[1]} R /Info {obj_num} 0 R /Prev {prev} >>\n"
        f"startxref\n{xref_at}\n%%EOF\n"
    ).encode()
    with open(out("incremental-updates.pdf"), "wb") as f:
        f.write(data + body + xref)

def scan_picture(seed, mode):
    rnd = random.Random(seed)
    img = Image.new("L", (1240, 1754), 235)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, 34)
    for i in range(28):
        d.text((110, 120 + i * 55), f"{i + 1}. {LOREM[: 40 + i]}", fill=30, font=font)
    img = img.rotate(0.8, fillcolor=235, resample=Image.BICUBIC)
    px = img.load()
    for _ in range(40000):
        x, y = rnd.randrange(img.width), rnd.randrange(img.height)
        px[x, y] = rnd.randrange(150, 255)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    return img if mode == "L" else img.point(lambda v: 255 if v > 140 else 0).convert("1")

def scanned():
    c = canvas.Canvas(out("scanned-jpeg.pdf"), pagesize=A4, invariant=1)
    for page in range(2):
        buf = io.BytesIO()
        scan_picture(page, "L").save(buf, "JPEG", quality=70)
        buf.seek(0)
        from reportlab.lib.utils import ImageReader
        c.drawImage(ImageReader(buf), 0, 0, *A4)
        c.showPage()
    c.save()
    with tempfile.TemporaryDirectory() as tmp:
        tif = os.path.join(tmp, "scan.tif")
        scan_picture(7, "1").save(tif, compression="group4", dpi=(150, 150))
        run("tiff2pdf", "-o", out("scanned-ccitt-g4.pdf"), tif)

def forms():
    c = canvas.Canvas(out("form-acroform.pdf"), pagesize=A4, invariant=1)
    f = c.acroForm
    c.setFont("Helvetica", 12)
    c.drawString(72, 760, "Nom :")
    f.textfield(name="nom", x=150, y=750, width=250, height=20, value="Dupont")
    c.drawString(72, 720, "Accepte :")
    f.checkbox(name="accepte", x=150, y=715, size=16, checked=False)
    c.drawString(72, 680, "Civilité :")
    f.radio(name="civilite", value="m", x=150, y=675, selected=True, size=16)
    f.radio(name="civilite", value="mme", x=190, y=675, selected=False, size=16)
    c.drawString(72, 640, "Pays :")
    f.choice(name="pays", x=150, y=630, width=150, height=20, options=["France", "Belgique", "Suisse"], value="France")
    f.listbox(name="langues", x=150, y=540, width=150, height=70, options=["fr", "en", "de"], value="fr")
    c.showPage()
    c.save()

def unicode_links_outlines():
    pdfmetrics.registerFont(TTFont("DejaVu", FONT))
    c = canvas.Canvas(out("unicode-links-outlines.pdf"), pagesize=A4, invariant=1)
    for i, title in enumerate(["Français — été", "Ελληνικά", "Русский текст"]):
        c.setFont("DejaVu", 20)
        c.drawString(72, 760, title)
        c.bookmarkPage(f"p{i}")
        c.addOutlineEntry(title, f"p{i}", level=0)
        c.setFillColor(blue)
        c.drawString(72, 700, "https://example.org")
        c.linkURL("https://example.org", (72, 695, 260, 720))
        c.setFillColor(red)
        c.drawString(72, 660, "→ page suivante")
        c.linkAbsolute("next", f"p{(i + 1) % 3}", (72, 655, 260, 680))
        c.setFillColorRGB(0, 0, 0)
        c.showPage()
    c.showOutline()
    c.save()

def existing_annotations():
    tmp = out("_ann.pdf")
    text_doc(tmp, pages=1)
    pdf = pikepdf.open(tmp)
    page = pdf.pages[0]
    page.Annots = pdf.make_indirect(pikepdf.Array([
        pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Highlight,
            Rect=[72, 700, 300, 716], QuadPoints=[72, 716, 300, 716, 72, 700, 300, 700],
            C=[1, 1, 0], Contents=pikepdf.String("surligné ailleurs"),
        )),
        pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Text,
            Rect=[400, 700, 420, 720], Contents=pikepdf.String("Une note"), Open=False,
        )),
    ]))
    pdf.save(out("foreign-annotations.pdf"), static_id=True)
    pdf.close()
    os.remove(tmp)

def encrypted():
    with open(out("password.txt"), "w") as f:
        f.write(PASSWORD + "\n")
    tmp = out("_enc.pdf")
    text_doc(tmp, pages=2)
    pdf = pikepdf.open(tmp)
    for name, kw in [
        ("encrypted-rc4-40.pdf", dict(R=2, aes=False, metadata=False)),
        ("encrypted-rc4-128.pdf", dict(R=3, aes=False, metadata=False)),
        ("encrypted-aes-128.pdf", dict(R=4, aes=True)),
        ("encrypted-aes-256.pdf", dict(R=6, aes=True)),
    ]:
        pdf.save(out(name), encryption=pikepdf.Encryption(user=PASSWORD, owner="owner-" + PASSWORD, **kw),
                 static_id=True)
    pdf.save(out("encrypted-owner-only.pdf"),
             encryption=pikepdf.Encryption(user="", owner="owner-" + PASSWORD, R=4, aes=True,
                                           allow=pikepdf.Permissions(extract=False, print_highres=False,
                                                                     print_lowres=False, modify_other=False)),
             static_id=True)
    pdf.close()
    os.remove(tmp)

def damaged_xref():
    src = out("pdf13-ghostscript.pdf")
    data = bytearray(open(src, "rb").read())
    at = data.rindex(b"\nxref") + 1
    lines = data[at:].split(b"\n")
    fixed = []
    for line in lines:
        parts = line.split(b" ")
        if len(parts) >= 3 and parts[2].startswith(b"n") and len(parts[0]) == 10:
            parts[0] = b"%010d" % (int(parts[0]) + 7)
            line = b" ".join(parts)
        fixed.append(line)
    data[at:] = b"\n".join(fixed)
    open(out("damaged-xref-offsets.pdf"), "wb").write(data)

def main():
    for f in os.listdir(HERE):
        if f.endswith(".pdf"):
            os.remove(out(f))
    classic_and_old_versions()
    incremental_updates()
    scanned()
    forms()
    unicode_links_outlines()
    existing_annotations()
    encrypted()
    damaged_xref()
    for f in sorted(os.listdir(HERE)):
        if f.endswith(".pdf"):
            print(f"{os.path.getsize(out(f)):>9}  {f}")

if __name__ == "__main__":
    main()
