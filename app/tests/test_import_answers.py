import importlib.util
import io
import subprocess
import sys
import tempfile
import zipfile
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

IMPORTER = Path(__file__).resolve().parents[1] / "import-answers.py"
spec = importlib.util.spec_from_file_location("import_answers", IMPORTER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def records(lines):
    return module.parse_lines(lines, "fixture.docx")


# Answer letters resolve to the option text, even when options are in unusual order.
ok, rejected = records(["单选题", "1. 哪个是C语言？", "B. Java", "A. C", "正确答案：A"])
assert len(ok) == 1 and ok[0]["answers"] == ["C"]
assert ok[0]["options"] == [{"text": "Java"}, {"text": "C"}]

# Layout whitespace around a complete option cannot break a text-valued answer.
ok, rejected = records(["1. 选一个 单选题", "A. correct   ", "B. wrong", "正确答案：correct"])
assert not rejected and ok[0]["answers"] == ["correct"]

# A choice can span paragraphs or Word line breaks; its complete text is the answer.
ok, rejected = records([
    "1. 以下分录正确的是？ 单选题",
    "A. 借：银行存款 100", "贷：实收资本 100",
    "B. 借：银行存款 100\r\n贷：营业外收入 100", "正确答案：A",
    "2. 下一题？ 单选题 A. 是 B. 否 正确答案：B",
])
assert not rejected and len(ok) == 2
assert ok[0]["options"] == [
    {"text": "借：银行存款 100\n贷：实收资本 100"},
    {"text": "借：银行存款 100\n贷：营业外收入 100"},
]
assert ok[0]["answers"] == ["借：银行存款 100\n贷：实收资本 100"]
assert ok[1]["answers"] == ["否"]

# Review sections and examples inside them cannot become choice continuations or answers.
for metadata in ["我的答案：B", "你的答案：B", "学生答案：B", "教师评语：正确答案：B", "答案解析：正确答案：B", "答案解析", "【解析】", "解析：错误", "满分：1", "得分：0", "窗体底端"]:
    ok, rejected = records([
        "1. 选一个 单选题", "A. 正确", "B. 错误", metadata,
        "这段是反馈说明", "C. 反馈中的示例", "正确答案：A",
    ])
    assert not rejected and len(ok) == 1, metadata
    assert ok[0]["options"] == [{"text": "正确"}, {"text": "错误"}], metadata
    assert ok[0]["answers"] == ["正确"], metadata

# The runtime collapses layout whitespace, so it cannot distinguish these choices.
ok, rejected = records(["1. 选一个", "A. 借：银行存款 100", "贷：实收资本 100", "B. 借：银行存款   100 贷：实收资本 100", "正确答案：A"])
assert not ok and rejected["选项键或选项文字重复"] == 1

# Quoted code whitespace, including escaped quotes, remains meaningful.
for left, right in [
    ('printf("Hello  world");', 'printf("Hello world");'),
    ("print('Hello  world')", "print('Hello world')"),
    (r'printf("say \"Hello  world\"");', r'printf("say \"Hello world\"");'),
    ('"Hello\u00a0world"', '"Hello world"'),
    ('What\'s "Hello  world"? It\'s code.', 'What\'s "Hello world"? It\'s code.'),
    ("L'  '", "L' '"),
]:
    ok, rejected = records(["1. 选一段代码 单选题", "A. " + left, "B. " + right, "正确答案：A"])
    assert not rejected and len(ok) == 1
    assert ok[0]["answers"] == [left]

ok, rejected = records(["1. 选一段代码 单选题", 'A. "Hello  ', '  world"', 'B. "Hello world"', "正确答案：A"])
assert not rejected and ok[0]["answers"] == ['"Hello  \n  world"']

# Real DOCX paragraphs and <w:br> must preserve spaces inside a wrapped literal.
for boundary in ['</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">', '</w:t><w:br/><w:t xml:space="preserve">']:
    xml = ('<w:document xmlns:w="' + module.WORD_NS + '"><w:body>'
           '<w:p><w:r><w:t>1. 选一段代码 单选题</w:t></w:r></w:p>'
           '<w:p><w:r><w:t xml:space="preserve">A. "Hello  ' + boundary + '  world"</w:t></w:r></w:p>'
           '<w:p><w:r><w:t>B. "Hello world"</w:t></w:r></w:p>'
           '<w:p><w:r><w:t>正确答案：A</w:t></w:r></w:p>'
           '</w:body></w:document>')
    blob = io.BytesIO()
    with zipfile.ZipFile(blob, "w") as z:
        z.writestr("word/document.xml", xml)
    lines, _ = module.docx_lines(blob.getvalue())
    ok, rejected = records(lines)
    assert not rejected and ok[0]["answers"] == ['"Hello  \n  world"']

# Test the PDF extraction boundary without requiring a local PDF engine.
page = SimpleNamespace(text='1. 选一段代码 单选题\nA. "Hello  \n  world"\nB. "Hello world"\n正确答案：A')
page.extract_text = lambda: page.text
pdf = SimpleNamespace(pages=[page])
with patch.dict(sys.modules, {"pdfplumber": SimpleNamespace(open=lambda _: nullcontext(pdf))}):
    ok, rejected = records(module.pdf_lines(b"fixture"))
    assert not rejected and ok[0]["answers"] == ['"Hello  \n  world"']
    page.text = "  A.  \n选项标签与正文分离"
    try:
        module.pdf_lines(b"fixture")
    except ValueError as exc:
        assert "选项标签与正文分离" in str(exc)
    else:
        raise AssertionError("detached PDF option keys were accepted")

# Missing options and answerless blocks are rejected rather than guessed.
ok, rejected = records(["1. 选一个", "A. only", "正确答案：A", "2. 没有答案？", "A. x", "B. y"])
assert not ok and sum(rejected.values()) == 2

# Ambiguous or absent answer labels are rejected.
ok, rejected = records(["1. 选一个", "A. x", "B. y", "正确答案：A/B"])
assert not ok and rejected["答案选项无法唯一映射"] == 1
ok, rejected = records(["1. ____", "我的答案：不应导入"])
assert not ok
ok, rejected = records(["1. 第一道题？ 2. 第二道题？", "A. x", "B. y", "正确答案：A"])
assert not ok

# Repeated option keys must survive the mapping representation and reject the record.
ok, rejected = records(["1. 选一个", "A. first", "A. overwritten", "B. second", "正确答案：A"])
assert not ok and rejected["选项键或选项文字重复"] == 1
ok, rejected = records(["1. 选一个", "A. first", "B. second", "正确答案：A", "A. overwritten"])
assert not ok and rejected["选项键或选项文字重复"] == 1

# An explicitly single-choice record cannot carry multiple correct answers.
ok, rejected = records(["单选题", "1. 选一个", "A. x", "B. y", "正确答案：A B"])
assert not ok and rejected["单选题答案数量冲突"] == 1

# Once answer labels repeat, a third label cannot make the record unambiguous again.
ok, rejected = records(["1. 选一个", "A. x", "B. y", "正确答案：A", "答案：B", "参考答案：A"])
assert not ok and rejected["重复答案标签"] >= 1

# A decimal in a question is not mistaken for another numbered question.
ok, rejected = records(["1. 3.14 的小数点怎么读？", "A. 三点一四", "B. 三点十四", "正确答案：A"])
assert len(ok) == 1 and ok[0]["answers"] == ["三点一四"]

# Multiple fill-ins retain answer order.
ok, rejected = records(["填空题", "1. ____与____", "参考答案：左；右"])
assert len(ok) == 1 and ok[0]["answers"] == ["左", "右"]

# Numbered fill labels are metadata, and their order must match the blanks.
ok, rejected = records(["填空题", "1. ____", "参考答案：第1空：借"])
assert len(ok) == 1 and ok[0]["answers"] == ["借"]
ok, rejected = records(["填空题", "1. ____与____", "参考答案：第1空：左；第2空：右"])
assert len(ok) == 1 and ok[0]["answers"] == ["左", "右"]
ok, rejected = records(["填空题", "1. ____与____", "参考答案：第2空：右；第1空：左"])
assert not ok and rejected["填空编号与空位不符"] == 1
ok, rejected = records(["填空题", "1. ____", "参考答案：第1空："])
assert not ok

# Unsafe ZIP paths are refused before any member is read or extracted.
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    z.writestr("../outside.docx", b"data")
buf.seek(0)
with zipfile.ZipFile(buf) as z:
    try:
        module.safe_members(z)
    except ValueError as exc:
        assert "路径穿越" in str(exc)
    else:
        raise AssertionError("path traversal ZIP was accepted")

with tempfile.TemporaryDirectory() as temp:
    original = Path(temp) / "keep.json"
    original.write_text("keep me")
    result = subprocess.run([sys.executable, str(IMPORTER), "unused.zip", "--out", str(original), "--audit", str(original)], capture_output=True)
    assert result.returncode == 2 and original.read_text() == "keep me"
    result = subprocess.run([sys.executable, str(IMPORTER), str(original), "--out", str(original), "--audit", str(Path(temp) / "audit.json")], capture_output=True)
    assert result.returncode == 2 and original.read_text() == "keep me"

print("import-answers assertions passed")
