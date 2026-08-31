from __future__ import annotations

import html
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    Image,
    KeepTogether,
    LongTable,
    PageBreak,
    PageTemplate,
    Paragraph,
    Preformatted,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs" / "00_SYSTEM_MODULES_AND_CHANGE_STANDARD.md"
SOURCE_TEXT = SOURCE.read_text(encoding="utf-8")


def source_header_value(label: str) -> str:
    match = re.search(rf"^> {re.escape(label)}：`([^`]+)`", SOURCE_TEXT, re.MULTILINE)
    if not match:
        raise RuntimeError(f"Missing {label} in {SOURCE}")
    return match.group(1)


VERSION = source_header_value("文档版本")
DATE = source_header_value("生效日期")
BASELINE = source_header_value("代码盘点基线")
OUTPUT = ROOT / "output" / "pdf" / f"LI3D_System_Maintenance_Manual_v{VERSION}.pdf"
SCREENSHOT = ROOT / "docs" / "assets" / "LI3D_EDITOR_UI_BASELINE.png"

PAGE_W, PAGE_H = LETTER
MARGIN = 0.72 * inch
CONTENT_W = PAGE_W - 2 * MARGIN

INK = colors.HexColor("#182230")
NAVY = colors.HexColor("#183B56")
BLUE = colors.HexColor("#2E74B5")
DARK_BLUE = colors.HexColor("#1F4D78")
MUTED = colors.HexColor("#5C6673")
LIGHT_BLUE = colors.HexColor("#E8EEF5")
LIGHT_GRAY = colors.HexColor("#F2F4F7")
BORDER = colors.HexColor("#B8C3CE")

pdfmetrics.registerFont(TTFont("MSYH", r"C:\Windows\Fonts\msyh.ttc", subfontIndex=0))
pdfmetrics.registerFont(TTFont("MSYH-Bold", r"C:\Windows\Fonts\msyhbd.ttc", subfontIndex=0))
pdfmetrics.registerFont(TTFont("Consolas", r"C:\Windows\Fonts\consola.ttf"))
pdfmetrics.registerFontFamily("MSYH", normal="MSYH", bold="MSYH-Bold")


def normalize(text: str) -> str:
    return (
        text.replace("\u2011", "-")
        .replace("\u2013", "-")
        .replace("\u2014", "-")
        .replace("  ", " ")
        .strip()
    )


def inline_markup(text: str) -> str:
    text = normalize(text)
    parts = re.split(r"(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^\)]+\))", text)
    output: list[str] = []
    for part in parts:
        if not part:
            continue
        if part.startswith("`") and part.endswith("`"):
            code_text = part[1:-1]
            # Consolas has no CJK glyphs.  Keep identifiers monospace, but use
            # the CJK body font for display labels such as `局部重绘 · 局部替换`.
            code_font = "MSYH" if any(ord(ch) > 127 for ch in code_text) else "Consolas"
            output.append(
                f"<font name='{code_font}' color='#1F4D78' size='8'>{html.escape(code_text)}</font>"
            )
        elif part.startswith("**") and part.endswith("**"):
            output.append(f"<b>{html.escape(part[2:-2])}</b>")
        elif part.startswith("["):
            match = re.match(r"\[([^\]]+)\]\(([^\)]+)\)", part)
            label = match.group(1) if match else part
            output.append(f"<font color='#2E74B5'><u>{html.escape(label)}</u></font>")
        else:
            output.append(html.escape(part))
    return "".join(output)


styles = getSampleStyleSheet()
BODY = ParagraphStyle(
    "BodyCN",
    parent=styles["BodyText"],
    fontName="MSYH",
    fontSize=9.6,
    leading=14,
    textColor=INK,
    spaceAfter=6,
    allowWidows=0,
    allowOrphans=0,
)
BODY_SMALL = ParagraphStyle(
    "BodySmallCN", parent=BODY, fontSize=8.2, leading=11.4, spaceAfter=3
)
H1 = ParagraphStyle(
    "Heading1CN",
    parent=BODY,
    fontName="MSYH-Bold",
    fontSize=16,
    leading=21,
    textColor=BLUE,
    spaceBefore=14,
    spaceAfter=8,
    keepWithNext=True,
)
H2 = ParagraphStyle(
    "Heading2CN",
    parent=BODY,
    fontName="MSYH-Bold",
    fontSize=12.5,
    leading=17,
    textColor=BLUE,
    spaceBefore=11,
    spaceAfter=6,
    keepWithNext=True,
)
H3 = ParagraphStyle(
    "Heading3CN",
    parent=BODY,
    fontName="MSYH-Bold",
    fontSize=10.5,
    leading=14,
    textColor=DARK_BLUE,
    spaceBefore=8,
    spaceAfter=4,
    keepWithNext=True,
)
TABLE_HEADER = ParagraphStyle(
    "TableHeaderCN",
    parent=BODY_SMALL,
    fontName="MSYH-Bold",
    fontSize=7.4,
    leading=10,
    textColor=NAVY,
    alignment=TA_CENTER,
)
TABLE_BODY = ParagraphStyle(
    "TableBodyCN", parent=BODY_SMALL, fontSize=7.2, leading=10, spaceAfter=0
)
CAPTION = ParagraphStyle(
    "CaptionCN",
    parent=BODY_SMALL,
    fontSize=7.7,
    leading=10,
    textColor=MUTED,
    alignment=TA_CENTER,
    spaceAfter=8,
)
CALLOUT_STYLE = ParagraphStyle(
    "CalloutCN",
    parent=BODY,
    fontSize=9,
    leading=13,
    leftIndent=9,
    rightIndent=7,
    spaceBefore=4,
    spaceAfter=8,
    borderColor=BLUE,
    borderWidth=0.8,
    borderPadding=7,
    backColor=colors.HexColor("#F4F6F9"),
)
LIST_STYLE = ParagraphStyle(
    "ListCN",
    parent=BODY,
    fontSize=9.2,
    leading=13.5,
    leftIndent=18,
    firstLineIndent=-9,
    bulletIndent=7,
    spaceAfter=4,
)
CODE_STYLE = ParagraphStyle(
    "CodeCN",
    parent=BODY_SMALL,
    fontName="MSYH",
    fontSize=7.5,
    leading=10.2,
    textColor=colors.HexColor("#263238"),
    leftIndent=7,
    rightIndent=7,
    spaceBefore=4,
    spaceAfter=7,
    backColor=colors.HexColor("#EEF1F4"),
    borderColor=MUTED,
    borderWidth=0.5,
    borderPadding=6,
)
CARD_TITLE = ParagraphStyle(
    "CardTitleCN",
    parent=BODY_SMALL,
    fontName="MSYH-Bold",
    fontSize=8.7,
    leading=12,
    textColor=NAVY,
    spaceBefore=4,
    spaceAfter=2,
    leftIndent=7,
    borderColor=BLUE,
    borderWidth=0.7,
    borderPadding=5,
    backColor=LIGHT_BLUE,
)
CARD_LINE = ParagraphStyle(
    "CardLineCN",
    parent=BODY_SMALL,
    fontSize=7.8,
    leading=10.7,
    leftIndent=12,
    rightIndent=5,
    spaceAfter=2,
)


class ManualDocTemplate(BaseDocTemplate):
    def __init__(self, filename: str):
        super().__init__(
            filename,
            pagesize=LETTER,
            leftMargin=MARGIN,
            rightMargin=MARGIN,
            topMargin=0.82 * inch,
            bottomMargin=0.72 * inch,
            title="LI3D 系统模块与算法维护手册",
            author="LI3D Engineering",
            subject="模块、投影、UV、局部重绘、图层、保存与变更控制",
        )
        frame = Frame(
            self.leftMargin,
            self.bottomMargin,
            self.width,
            self.height,
            id="body",
            leftPadding=0,
            rightPadding=0,
            topPadding=0,
            bottomPadding=0,
        )
        self.addPageTemplates([PageTemplate(id="manual", frames=frame, onPage=draw_header_footer)])
        self._bookmark_counter = 0

    def beforeDocument(self):
        self._bookmark_counter = 0
        return super().beforeDocument()

    def afterFlowable(self, flowable):
        if isinstance(flowable, Paragraph) and hasattr(flowable, "toc_level"):
            level = flowable.toc_level
            text = flowable.getPlainText()
            key = f"heading-{self._bookmark_counter}"
            self._bookmark_counter += 1
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(text, key, level=level, closed=False)
            self.notify("TOCEntry", (level, text, self.page, key))


def draw_header_footer(canvas, doc) -> None:
    page = canvas.getPageNumber()
    canvas.saveState()
    if page > 1:
        canvas.setStrokeColor(colors.HexColor("#D7DEE5"))
        canvas.setLineWidth(0.5)
        canvas.line(MARGIN, PAGE_H - 0.55 * inch, PAGE_W - MARGIN, PAGE_H - 0.55 * inch)
        canvas.setFont("MSYH-Bold", 7.4)
        canvas.setFillColor(MUTED)
        canvas.drawString(MARGIN, PAGE_H - 0.45 * inch, "LI3D ENGINEERING / SYSTEM MAINTENANCE BASELINE")
        canvas.setFont("MSYH", 7.4)
        canvas.drawRightString(PAGE_W - MARGIN, 0.43 * inch, f"v{VERSION}  |  {DATE}  |  {page}")
    canvas.restoreState()


def heading(text: str, level: int) -> Paragraph:
    style = {0: H1, 1: H2, 2: H3}[level]
    p = Paragraph(inline_markup(text), style)
    p.toc_level = level
    return p


def cover_story() -> list:
    story: list = [Spacer(1, 0.72 * inch)]
    kicker = ParagraphStyle("CoverKicker", parent=BODY, fontName="MSYH-Bold", fontSize=9,
                            leading=12, alignment=TA_CENTER, textColor=BLUE, spaceAfter=16)
    title = ParagraphStyle("CoverTitle", parent=BODY, fontName="MSYH-Bold", fontSize=26,
                           leading=34, alignment=TA_CENTER, textColor=NAVY, spaceAfter=6)
    subtitle = ParagraphStyle("CoverSubtitle", parent=BODY, fontSize=11.5, leading=16,
                              alignment=TA_CENTER, textColor=DARK_BLUE, spaceAfter=18)
    scope = ParagraphStyle("CoverScope", parent=BODY, fontName="MSYH-Bold", fontSize=9.2,
                           leading=13, alignment=TA_CENTER, textColor=MUTED, spaceAfter=54)
    story.extend([
        Paragraph("LI3D ENGINEERING", kicker),
        Paragraph("系统模块与算法维护手册", title),
        Paragraph("System Modules, Algorithms &amp; Change-Control Manual", subtitle),
        Paragraph("投影 / UV 合成 / 局部重绘 / 图层 / 保存与版本历史", scope),
    ])
    data = [
        [Paragraph("文档版本", TABLE_HEADER), Paragraph(VERSION, TABLE_BODY)],
        [Paragraph("规范状态", TABLE_HEADER), Paragraph("当前唯一维护准则 / Normative Baseline", TABLE_BODY)],
        [Paragraph("生效日期", TABLE_HEADER), Paragraph(DATE, TABLE_BODY)],
        [Paragraph("代码盘点基线", TABLE_HEADER), Paragraph(html.escape(BASELINE), TABLE_BODY)],
        [Paragraph("适用对象", TABLE_HEADER), Paragraph("两位维护者、Codex、后续开发与测试人员", TABLE_BODY)],
    ]
    table = Table(data, colWidths=[1.3 * inch, CONTENT_W - 1.3 * inch], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.45, BORDER),
        ("BACKGROUND", (0, 0), (0, -1), LIGHT_BLUE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.extend([table, PageBreak()])
    return story


def front_matter() -> list:
    story: list = [heading("文档控制", 0)]
    story.append(Paragraph(
        "本文档既是系统模块目录，也是算法注册表和强制变更流程。任何行为修改必须先定位 M/UI/ALG ID，再建立 CHG 记录；历史方案不能覆盖本手册的当前真值。",
        CALLOUT_STYLE,
    ))
    rows = [
        ("规范范围", "模块边界、界面调用、算法参数、图层语义、保存、版本、测试与变更控制"),
        ("真值原则", "代码是实现证据；本手册是维护规范。冲突必须建立变更记录后同时修正。"),
        ("算法版本", "规范版本与运行版本分离；没有持久化标记的算法明确登记为治理缺口。"),
        ("源码历史", "Git + CHANGELOG + docs/changes + ADR；工程 autosave 不能代替源码版本。"),
        ("默认修改上限", "普通 Bug 修复限制在一个大模块、通常不超过 5 个源文件或 300 行净变化。"),
    ]
    data = [[Paragraph("控制项", TABLE_HEADER), Paragraph("当前规则", TABLE_HEADER)]]
    data += [[Paragraph(a, TABLE_BODY), Paragraph(b, TABLE_BODY)] for a, b in rows]
    table = LongTable(data, colWidths=[1.35 * inch, CONTENT_W - 1.35 * inch], repeatRows=1)
    table.setStyle(default_table_style())
    story.extend([table, Spacer(1, 10), heading("目录", 0)])
    toc = TableOfContents()
    toc.levelStyles = [
        ParagraphStyle("TOC1", parent=BODY, fontName="MSYH-Bold", fontSize=9.2, leading=13,
                       leftIndent=0, firstLineIndent=0, spaceBefore=4, textColor=NAVY),
        ParagraphStyle("TOC2", parent=BODY_SMALL, fontSize=8.2, leading=11.5,
                       leftIndent=14, firstLineIndent=0, spaceBefore=2, textColor=INK),
        ParagraphStyle("TOC3", parent=BODY_SMALL, fontSize=7.6, leading=10.5,
                       leftIndent=28, firstLineIndent=0, spaceBefore=1, textColor=MUTED),
    ]
    story.extend([toc, PageBreak()])
    return story


def default_table_style() -> TableStyle:
    return TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.4, BORDER),
        ("BACKGROUND", (0, 0), (-1, 0), LIGHT_BLUE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAFBFC")]),
    ])


def visual_len(text: str) -> int:
    return sum(2 if ord(ch) > 127 else 1 for ch in text)


def split_row(line: str) -> list[str]:
    line = line.strip().strip("|")
    return [part.strip().replace("\\|", "|") for part in line.split("|")]


def separator(line: str) -> bool:
    cells = split_row(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in cells)


def record_cards(headers: list[str], rows: list[list[str]]) -> list:
    flowables: list = []
    for row in rows:
        pieces: list = [Paragraph(inline_markup(row[0]), CARD_TITLE)]
        for label, value in zip(headers[1:], row[1:]):
            pieces.append(Paragraph(f"<b><font color='#1F4D78'>{html.escape(label)}：</font></b>{inline_markup(value)}", CARD_LINE))
        pieces.append(Spacer(1, 3))
        flowables.append(KeepTogether(pieces))
    return flowables


def table_flowables(headers: list[str], rows: list[list[str]]) -> list:
    max_body = max((visual_len(cell) for row in rows for cell in row), default=0)
    average = sum(visual_len(cell) for row in rows for cell in row) / max(1, sum(len(r) for r in rows))
    if len(headers) >= 4 or (len(headers) == 3 and (max_body > 180 or average > 55)):
        return record_cards(headers, rows)
    data = [[Paragraph(inline_markup(x), TABLE_HEADER) for x in headers]]
    data += [[Paragraph(inline_markup(x), TABLE_BODY) for x in row] for row in rows]
    if len(headers) == 1:
        widths = [CONTENT_W]
    elif len(headers) == 2:
        first_len = max(visual_len(row[0]) for row in [headers] + rows)
        first = min(2.15 * inch, max(1.25 * inch, (0.75 + first_len * 0.04) * inch))
        widths = [first, CONTENT_W - first]
    else:
        lens = [max(visual_len(row[i]) for row in [headers] + rows) for i in range(3)]
        weights = [max(1.0, min(3.5, x ** 0.5)) for x in lens]
        widths = [CONTENT_W * weight / sum(weights) for weight in weights]
    table = LongTable(data, colWidths=widths, repeatRows=1, hAlign="LEFT", splitByRow=1)
    table.setStyle(default_table_style())
    return [table, Spacer(1, 6)]


def page_break_before(text: str, level: int) -> bool:
    if level != 0:
        return False
    match = re.match(r"(\d+)\.", text)
    return bool(match and int(match.group(1)) in {3, 5, 6, 7, 8, 14, 16, 17, 18, 19, 20, 21, 22})


def markdown_story(markdown: str) -> list:
    lines = markdown.splitlines()
    story: list = []
    i = 0
    seen = False
    paragraph_buffer: list[str] = []

    def flush() -> None:
        nonlocal paragraph_buffer
        if paragraph_buffer:
            story.append(Paragraph(inline_markup(" ".join(paragraph_buffer)), BODY))
            paragraph_buffer = []

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not seen:
            if stripped.startswith("## 1."):
                seen = True
            else:
                i += 1
                continue

        h = re.match(r"^(#{2,4})\s+(.+)$", stripped)
        if h:
            flush()
            level = len(h.group(1)) - 2
            title = normalize(h.group(2))
            if page_break_before(title, level):
                story.append(PageBreak())
            story.append(heading(title, level))
            if title.startswith("14. 编辑器界面模块总图") and SCREENSHOT.exists():
                image = Image(str(SCREENSHOT), width=CONTENT_W, height=CONTENT_W * 1295 / 2527)
                image.hAlign = "CENTER"
                story.extend([image, Paragraph("图 1  LI3D 贴图编辑器界面与 UI 模块审计基准", CAPTION)])
            i += 1
            continue

        if stripped.startswith("```"):
            flush()
            i += 1
            code: list[str] = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code.append(lines[i])
                i += 1
            story.append(Preformatted("\n".join(code), CODE_STYLE, maxLineLength=100))
            i += 1
            continue

        if stripped.startswith(">"):
            flush()
            quotes: list[str] = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quotes.append(lines[i].lstrip("> ").strip())
                i += 1
            story.append(Paragraph(inline_markup(" ".join(quotes)), CALLOUT_STYLE))
            continue

        if stripped.startswith("|") and i + 1 < len(lines) and separator(lines[i + 1]):
            flush()
            headers = split_row(line)
            rows: list[list[str]] = []
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                row = split_row(lines[i])
                row += [""] * (len(headers) - len(row))
                rows.append(row[: len(headers)])
                i += 1
            story.extend(table_flowables(headers, rows))
            continue

        bullet = re.match(r"^(\s*)-\s+(.+)$", line)
        if bullet:
            flush()
            level = min(2, len(bullet.group(1).replace("\t", "  ")) // 2)
            style = ParagraphStyle(f"Bullet{level}", parent=LIST_STYLE,
                                   leftIndent=18 + level * 12, bulletIndent=7 + level * 12)
            story.append(Paragraph(inline_markup(bullet.group(2)), style, bulletText="•"))
            i += 1
            continue

        number = re.match(r"^(\s*)(\d+)\.\s+(.+)$", line)
        if number:
            flush()
            level = min(2, len(number.group(1).replace("\t", "  ")) // 2)
            style = ParagraphStyle(f"Number{level}", parent=LIST_STYLE,
                                   leftIndent=20 + level * 12, firstLineIndent=-12)
            story.append(Paragraph(inline_markup(number.group(3)), style, bulletText=number.group(2) + "."))
            i += 1
            continue

        if not stripped:
            flush()
            i += 1
            continue

        paragraph_buffer.append(stripped)
        i += 1
    flush()
    return story


def main() -> None:
    markdown = SOURCE.read_text(encoding="utf-8")
    story = cover_story() + front_matter() + markdown_story(markdown)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = ManualDocTemplate(str(OUTPUT))
    doc.multiBuild(story)
    print(f"Created {OUTPUT}")


if __name__ == "__main__":
    main()
