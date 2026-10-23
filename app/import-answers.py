#!/usr/bin/env python3
"""Conservatively import explicitly labeled answers from a MOOC answer ZIP."""
import argparse
import collections
import io
import json
import re
import stat
import subprocess
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree

MAX_ARCHIVE = 100 * 1024 * 1024
MAX_TOTAL = 300 * 1024 * 1024
MAX_MEMBER = 50 * 1024 * 1024
MAX_RATIO = 100
ANSWER_RE = re.compile(r"(?<!我的)(?<!你的)(?<!学生)(?:正确答案|参考答案|答案)\s*[:：]\s*(.*)$", re.I)
OPTION_RE = re.compile(r"^\s*([A-H])\s*[.．、:：)）]\s*(\S.*)$", re.I)
QUESTION_RE = re.compile(r"^\s*(?:第\s*)?\d{1,4}\s*[、.．)）]\s*(\S.*)$")
BLANK_RE = re.compile(r"_{2,}|＿{2,}|[（(]\s*[　 ]*[）)]")
TYPE_RE = re.compile(r"(单选题|多选题|填空题|单选|多选|填空)")
REVIEW_RE = re.compile(r"^[【\[]?(?:我的答案|你的答案|学生答案|教师评语|答案解析|试题解析|参考解析|解析|评语|满分|得分|作答情况|作答结果|答题情况)[】\]]?\s*(?:[:：]|$)|^窗体(?:顶端|底端)$")
ANSWER_TEXT_RE = re.compile(r'''"(?:\\[\s\S]|[^"\\])*"|(?<![A-Za-z0-9_])(?:u8|[LuU])?'(?:\\[\s\S]|[^'\\])*'|[\t-\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+''')
WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def normalized_answer_text(value):
    return ANSWER_TEXT_RE.sub(lambda match: " " if match[0][0].isspace() or match[0][0] == "\ufeff" else match[0], value).strip(" ")


def safe_members(zf):
    infos = zf.infolist()
    if sum(i.file_size for i in infos) > MAX_TOTAL:
        raise ValueError("ZIP展开总量超过限制")
    for info in infos:
        raw = info.filename
        for candidate in (raw, raw.replace("\\", "/")):
            if candidate.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", candidate):
                raise ValueError("ZIP含绝对路径")
            if ".." in candidate.split("/"):
                raise ValueError("ZIP含路径穿越")
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise ValueError("ZIP含符号链接")
        if info.file_size > MAX_MEMBER:
            raise ValueError("ZIP成员超过大小限制")
        if info.file_size and (not info.compress_size or info.file_size / info.compress_size > MAX_RATIO):
            raise ValueError("ZIP成员压缩比超过限制")
    return infos


def decoded_name(name):
    try:
        return name.encode("cp437").decode("gb18030")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name


def docx_lines(blob):
    with zipfile.ZipFile(io.BytesIO(blob)) as doc:
        if sum(i.file_size for i in doc.infolist()) > 100 * 1024 * 1024:
            raise ValueError("DOCX展开总量超过限制")
        root = ElementTree.fromstring(doc.read("word/document.xml"))
    lines = []
    red_runs = 0
    for para in root.iter(f"{{{WORD_NS}}}p"):
        parts = []
        for run in para.iter(f"{{{WORD_NS}}}r"):
            text = "".join(node.text or "" if node.tag == f"{{{WORD_NS}}}t" else "\t" if node.tag == f"{{{WORD_NS}}}tab" else "\n" if node.tag == f"{{{WORD_NS}}}br" else "" for node in run.iter())
            parts.append(text)
            color = run.find(f"{{{WORD_NS}}}rPr/{{{WORD_NS}}}color")
            if color is not None and color.get(f"{{{WORD_NS}}}val", "").lower() in {"ff0000", "red", "c00000"}:
                red_runs += 1
        line = "".join(parts)
        if line.strip():
            lines.append(line)
    return lines, red_runs


def pdf_lines(blob):
    try:
        import pdfplumber
    except ImportError as exc:
        raise RuntimeError("PDF解析库不可用") from exc
    with pdfplumber.open(io.BytesIO(blob)) as pdf:
        if len(pdf.pages) > 300:
            raise ValueError("PDF页数超过限制")
        lines = [line for page in pdf.pages for line in (page.extract_text() or "").splitlines() if line.strip()]
    # Detached option keys are a strong sign that PDF reading order interleaved columns.
    if any(re.fullmatch(r"[A-H][.．、:：]?", line.strip(), re.I) for line in lines):
        raise ValueError("PDF选项标签与正文分离，文本顺序不可靠")
    return lines


def doc_lines(blob):
    # textutil is macOS's built-in converter; write only this validated member to a temporary file.
    with tempfile.TemporaryDirectory(prefix="szu-uooc-doc-") as temp:
        source = Path(temp) / "source.doc"
        source.write_bytes(blob)
        result = subprocess.run(["textutil", "-convert", "txt", "-stdout", str(source)], capture_output=True, check=True, timeout=30)
        if len(result.stdout) > 25 * 1024 * 1024:
            raise ValueError("DOC文本输出超过限制")
        return result.stdout.decode("utf-8", "replace").splitlines()


def parse_lines(lines, filename):
    accepted, rejected = [], collections.Counter()
    context_type = ""
    block = None

    def flush():
        nonlocal block
        if not block:
            return
        q = " ".join(block["question"]).strip()
        options = {key: text.strip() for key, text in block["options"].items()}
        raw_answer = block["answer"]
        kind_hint = block["kind"] or context_type
        if block["answer_ambiguous"]:
            rejected["重复答案标签"] += 1
            block = None
            return
        if re.search(r"(?:我的答案|你的答案|教师评语|答案解析|窗体顶端|窗体底端|满分\s*[:：]|得分\s*[:：])", q) or re.search(r"(?<!\d)\d{1,3}\s*[、.．)](?!\d)\s*", q):
            rejected["题干混入作答信息或多个题目"] += 1
            block = None
            return
        if not q or not raw_answer:
            rejected["缺少明确答案标签或题干"] += 1
            block = None
            return
        explicit_single = "单选" in kind_hint and "多选" not in kind_hint
        explicit_multi = "多选" in kind_hint
        explicit_fill = "填空" in kind_hint
        if len(options) >= 2:
            if len(block["option_keys"]) != len(set(block["option_keys"])) or len({normalized_answer_text(text) for text in options.values()}) != len(options):
                rejected["选项键或选项文字重复"] += 1
                block = None
                return
            raw = raw_answer.strip()
            tokens = [raw] if raw in options.values() else re.split(r"[、,，;；\s]+", raw.strip(" []【】()（）"))
            mapped = []
            for token in tokens:
                key = token.strip().rstrip(".、．")
                if key.upper() in options:
                    mapped.append(options[key.upper()])
                elif key in options.values():
                    mapped.append(key)
                else:
                    mapped = []
                    break
            if not mapped or len(mapped) != len(set(mapped)):
                rejected["答案选项无法唯一映射"] += 1
                block = None
                return
            if explicit_fill:
                rejected["题型与选项结构冲突"] += 1
                block = None
                return
            if explicit_single and len(mapped) != 1:
                rejected["单选题答案数量冲突"] += 1
                block = None
                return
            kind = "多选题" if (explicit_multi or (not explicit_single and len(mapped) > 1)) else "单选题"
            accepted.append({"question": q, "type": kind, "options": [{"text": v} for v in options.values()], "answers": mapped, "source": filename})
        elif explicit_single or explicit_multi:
            rejected["选择题选项结构不完整"] += 1
        elif explicit_fill or BLANK_RE.search(q):
            if options:
                rejected["填空题含不完整选项"] += 1
            elif re.search(r"(?:^|\s)[A-H]\s*[.．、:：)]", q, re.I) or re.search(r"\d{1,3}\s*[【\[]\s*(?:单选|多选|填空)", q):
                rejected["题干含未拆分选择题结构"] += 1
            elif re.search(r"(?:我的答案|你的答案|学生答案|答案解析|教师评语|满分|得分)", raw_answer):
                rejected["答案标签混有作答或批阅信息"] += 1
            else:
                answers = [x.strip() for x in re.split(r"[、;；|]", raw_answer.strip()) if x.strip()]
                numbered = [re.fullmatch(r"第\s*(\d+)\s*空\s*[:：]\s*(.*)", answer) for answer in answers]
                if any(numbered):
                    if not all(match and int(match[1]) == index + 1 and match[2].strip() for index, match in enumerate(numbered)):
                        rejected["填空编号与空位不符"] += 1
                        block = None
                        return
                    answers = [match[2].strip() for match in numbered]
                blanks = max(1, len(BLANK_RE.findall(q)))
                if len(answers) != blanks:
                    rejected["填空答案数量与空位不符"] += 1
                else:
                    accepted.append({"question": q, "type": "填空题", "answers": answers, "source": filename})
        else:
            rejected["选项结构不完整或题型不明"] += 1
        block = None

    for original in (line for paragraph in lines for line in paragraph.splitlines()):
        line = original.strip()
        if not line:
            continue
        # Split inline choices/answers while retaining their original order.
        inline_answer = None if REVIEW_RE.match(line) else ANSWER_RE.search(line)
        answer_tail = inline_answer.group(1).strip() if inline_answer else None
        if inline_answer:
            line = line[:inline_answer.start()].strip()
        option_marks = list(re.finditer(r"(?:^|\s)([A-H])\s*[.．、:：)）]\s*", line, re.I))
        if len(option_marks) >= 2:
            segments = []
            prefix = line[:option_marks[0].start()].strip()
            if prefix:
                segments.append(prefix)
            for index, mark in enumerate(option_marks):
                start = mark.end()
                end = option_marks[index + 1].start() if index + 1 < len(option_marks) else len(line)
                segments.append(mark.group(1).upper() + ". " + line[start:end].strip())
            if answer_tail is not None:
                segments.append("正确答案：" + answer_tail)
            pending = segments
        else:
            pending = [original if inline_answer is None else line]
            if answer_tail is not None:
                pending.append("正确答案：" + answer_tail)
        queue = pending
        while queue:
            raw_line = queue.pop(0)
            line = raw_line.strip()
            if not line:
                continue
            markers = TYPE_RE.findall(line)
            if markers and block is None:
                context_type = markers[-1]
            qmatch = QUESTION_RE.match(line)
            if qmatch and not OPTION_RE.match(line):
                flush()
                body = qmatch.group(1)
                kinds = TYPE_RE.findall(body)
                block = {"question": [body], "options": collections.OrderedDict(), "option_keys": [], "answer": "", "answer_seen": False, "answer_ambiguous": False, "options_closed": False, "kind": kinds[-1] if kinds else context_type}
                inline = ANSWER_RE.search(body)
                if inline:
                    block["answer"] = inline.group(1)
                    block["answer_seen"] = True
                    block["question"] = [body[:inline.start()].strip()]
                continue
            if block is None:
                continue
            if REVIEW_RE.match(line):
                block["options_closed"] = True
                continue
            omatch = OPTION_RE.match(raw_line)
            if omatch:
                if not block["options_closed"]:
                    key, text = omatch.groups()
                    block["option_keys"].append(key.upper())
                    block["options"][key.upper()] = text
                continue
            amatch = ANSWER_RE.search(line)
            if amatch:
                if block["answer_seen"]:
                    block["answer_ambiguous"] = True
                else:
                    block["answer_seen"] = True
                    block["answer"] = amatch.group(1).strip()
                continue
            if not block["options_closed"] and not block["answer_seen"]:
                if block["options"]:
                    block["options"][block["option_keys"][-1]] += "\n" + raw_line
                else:
                    block["question"].append(line)
    flush()
    return accepted, rejected


def import_zip(zip_path):
    archive = Path(zip_path)
    if archive.stat().st_size > MAX_ARCHIVE:
        raise ValueError("ZIP文件超过大小限制")
    all_questions, stats, rejected_files = [], collections.Counter(), []
    with zipfile.ZipFile(archive) as zf:
        infos = safe_members(zf)
        stats["zip_members"] = len(infos)
        stats["member_types"] = dict(collections.Counter(Path(decoded_name(i.filename)).suffix.lower() or "[无扩展名]" for i in infos if not i.is_dir()))
        for info in infos:
            if info.is_dir():
                continue
            name = decoded_name(info.filename)
            ext = Path(name).suffix.lower()
            if ext not in {".docx", ".pdf", ".doc"}:
                stats["unsupported_format"] += 1
                rejected_files.append({"file": name, "reason": "不支持的格式"})
                continue
            try:
                blob = zf.read(info)
                if ext == ".docx":
                    lines, red = docx_lines(blob)
                    stats["red_runs_observed"] += red
                elif ext == ".pdf":
                    lines = pdf_lines(blob)
                else:
                    lines = doc_lines(blob)
                records, reasons = parse_lines(lines, name)
                all_questions.extend(records)
                stats["accepted_records"] += len(records)
                stats["rejected_records"] += sum(reasons.values())
                stats.update({f"reason:{k}": v for k, v in reasons.items()})
            except Exception as exc:
                reason = "读取或解析失败：" + (str(exc)[:120] or type(exc).__name__)
                rejected_files.append({"file": name, "reason": reason})
                stats["file_parse_failed"] += 1
    return {"questions": all_questions, "rejected": {"stats": dict(stats), "files": rejected_files}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("zip", help="输入答案 ZIP")
    parser.add_argument("--out", required=True, help="questions JSON 输出路径")
    parser.add_argument("--audit", required=True, help="审计 JSON 输出路径")
    args = parser.parse_args()
    out = Path(args.out)
    audit = Path(args.audit)
    if len({Path(args.zip).resolve(), out.resolve(), audit.resolve()}) != 3:
        parser.error("ZIP、答案输出、审计输出必须是不同路径")
    result = import_zip(args.zip)
    out.parent.mkdir(parents=True, exist_ok=True)
    audit.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    audit.write_text(json.dumps({"imported": len(result["questions"]), "rejected": result["rejected"]}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"导入 {len(result['questions'])} 条；拒绝/失败统计已写入 {audit}")


if __name__ == "__main__":
    main()
