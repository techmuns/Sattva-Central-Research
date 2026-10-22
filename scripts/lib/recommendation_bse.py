"""Free BSE company result discovery and a deliberately narrow Inline XBRL adapter.

No HTML table inference, filename dates, financial estimates or source-refusal bypasses.
The index is an observed list, not proof of an exhaustive BSE archive.
"""
import copy
import datetime as dt
import decimal
import io
import re
import xml.etree.ElementTree as ET
from urllib.parse import urlencode

from recommendation_foundation import METRICS, XBRLI, day, document_url, local, parse_financial_xml

BSE_RESULTS_PATH = "/BseIndiaAPI/api/Corp_FinanceResult_ng_new/w"
IX = "http://www.xbrl.org/2013/inlineXBRL"
TRANSFORMS = {
    "http://www.xbrl.org/inlineXBRL/transformation/2011-07-31",
    "http://www.xbrl.org/inlineXBRL/transformation/2015-02-26",
}
METADATA = {"ISIN", "ScripCode", "Symbol", "NSESymbol", "NatureOfReportStandaloneConsolidated",
    "DateOfStartOfReportingPeriod", "DateOfEndOfReportingPeriod", "DateOfBoardMeetingWhenFinancialResultsWereApproved"}


def bse_index_url(code):
    if not re.fullmatch(r"\d{6}", str(code)):
        raise ValueError("An exact BSE security code is required")
    # FlagDur=7 is the public company page's own history option, including recent filings.
    return "https://api.bseindia.com" + BSE_RESULTS_PATH + "?" + urlencode({
        "SCRIP_CD": str(code), "FlagDur": "7", "HFQ": "", "ISUBGROUP_CODE": "", "segment": "C"})


def bse_recent_url():
    # The public page permits exchange-wide discovery only in its current-results option.
    return "https://api.bseindia.com" + BSE_RESULTS_PATH + "?" + urlencode({
        "SCRIP_CD": "", "FlagDur": "1", "HFQ": "", "ISUBGROUP_CODE": "", "segment": "C"})


def reporting_end_hint(row):
    """Queue hint only. Original XBRL contexts remain the sole financial-period authority."""
    match = re.fullmatch(r"(JQ|SQ|SH|DQ|DN|MQ|MC)(\d{4})-(\d{4})", str(row.get("quarter_code", "")))
    if not match or int(match[3]) != int(match[2]) + 1:
        return None
    year, suffix = (match[3], "03-31") if match[1] in {"MQ", "MC"} else (match[2],
        "06-30" if match[1] == "JQ" else "09-30" if match[1] in {"SQ", "SH"} else "12-31")
    return day(year + "-" + suffix)


def result_links(row):
    links = []
    for field in ("XMLName", "Consol_XMLName"):
        value = row.get(field)
        if value is None or value == "":
            continue
        # These relative XBRLFILES links are exactly how BSE's public page renders them.
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_/-]+\.(?:html|xml)", value, re.I) or ".." in value:
            raise ValueError("Unexpected BSE original-link schema")
        url = document_url("https://www.bseindia.com/XBRLFILES/" + value)
        if not url:
            raise ValueError("Unsupported BSE original link")
        if url not in links:
            links.append(url)
    return links


def qname(value, namespaces):
    parts = str(value or "").split(":")
    if len(parts) != 2 or parts[0] not in namespaces or not re.fullmatch(r"[A-Za-z_][\w.-]*", parts[1]):
        raise ValueError("Unresolved Inline XBRL qualified name")
    return "{" + namespaces[parts[0]] + "}" + parts[1]


def transform(text, node, namespaces):
    fmt = qname(node.get("format"), namespaces) if node.get("format") else None
    name = local(fmt) if fmt else None
    namespace = fmt.split("}")[0][1:] if fmt else None
    # BSE's current renderer binds the legacy numdotdecimalin spelling to the 2020
    # registry URI (which renamed it num-dot-decimal). This explicit source adapter
    # accepts only that observed pair, with strict Indian grouping and explicit scale.
    bse_numeric = namespace == "http://www.xbrl.org/inlineXBRL/transformation/2020-02-12" and name == "numdotdecimalin"
    if fmt and namespace not in TRANSFORMS and not bse_numeric:
        raise ValueError("Unsupported Inline XBRL transformation namespace")
    if local(node.tag) == "nonNumeric":
        if not fmt:
            return text.strip()
        if name == "datedaymonthyear":
            match = re.fullmatch(r"\s*(\d{1,2})\D+(\d{1,2})\D+(\d{4})\s*", text)
            if match:
                return dt.date(int(match[3]), int(match[2]), int(match[1])).isoformat()
        raise ValueError("Unsupported Inline XBRL text transformation")
    value = text.strip()
    if fmt:
        if name not in {"numdotdecimal", "numdotdecimalin"}:
            raise ValueError("Unsupported Inline XBRL numeric transformation")
        # Validate grouping before removing it; a comma must never become a decimal separator.
        pattern = (r"(?:\d+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d+)?" if name == "numdotdecimalin"
            else r"(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?")
        if not re.fullmatch(pattern, value):
            raise ValueError("Unsupported Inline XBRL number representation")
        value = value.replace(",", "")
    if not re.fullmatch(r"\d+(?:\.\d+)?", value) or len(value) > 100:
        raise ValueError("Invalid Inline XBRL number")
    scale = node.get("scale", "0")
    if not re.fullmatch(r"-?\d{1,2}", scale) or abs(int(scale)) > 20 or node.get("sign") not in {None, "-"}:
        raise ValueError("Unsupported Inline XBRL scale/sign")
    with decimal.localcontext() as ctx:
        ctx.prec = 120
        result = decimal.Decimal(value).scaleb(int(scale))
        return format(-result if node.get("sign") == "-" else result, "f")


def parse_bse_ixbrl(body, expected):
    if len(body) > 4 * 1024 * 1024 or re.search(br"<!DOCTYPE|<!ENTITY", body, re.I):
        raise ValueError("Unsafe or oversized Inline XBRL")
    # Resolve names in their actual element scope. A rebound prefix cannot impersonate a taxonomy.
    scopes, stack, pending = {}, [], []
    parser = ET.iterparse(io.BytesIO(body), events=("start-ns", "start", "end"))
    for event, item in parser:
        if event == "start-ns":
            pending.append(item)
        elif event == "start":
            scope = dict(stack[-1]) if stack else {}
            scope.update(pending); pending.clear(); stack.append(scope); scopes[id(item)] = scope
        else:
            stack.pop()
    root = parser.root
    if root.tag != "{http://www.w3.org/1999/xhtml}html":
        raise ValueError("Not a supported BSE XHTML Inline XBRL filing")
    instance, originals, problems = ET.Element("{" + XBRLI + "}xbrl"), [], []
    ids = set()
    for node in root.iter():
        if node.tag in {"{" + XBRLI + "}context", "{" + XBRLI + "}unit"}:
            identifier = node.get("id")
            if not identifier or identifier in ids:
                raise ValueError("Ambiguous Inline XBRL context/unit identifiers")
            ids.add(identifier)
            copied = copy.deepcopy(node)
            if local(node.tag) == "context":
                identifiers = [n for n in node.iter() if n.tag == "{" + XBRLI + "}identifier"]
                if len(identifiers) != 1 or identifiers[0].get("scheme") not in {
                        "http://www.sebi.gov.in/in-capmkt/ScripCode", "http://www.bseindia.com/in-capmkt/ScripCode"} or (identifiers[0].text or "").strip() not in expected["bseCodes"]:
                    problems.append({"context": identifier, "reason": "Unverified BSE context entity"})
            else:
                for original_measure, measure in zip(node.iter(), copied.iter()):
                    if measure.tag == "{" + XBRLI + "}measure":
                        resolved = qname(original_measure.text, scopes[id(original_measure)])
                        if resolved.startswith("{http://www.xbrl.org/2003/iso4217}"):
                            measure.text = "iso4217:" + local(resolved)
                        elif resolved in {"{" + XBRLI + "}shares", "{" + XBRLI + "}pure"}:
                            measure.text = "xbrli:" + local(resolved)
                        else:
                            problems.append({"unit": identifier, "reason": "Unsupported BSE unit measure namespace"})
            instance.append(copied)
    for node in root.iter():
        if node.tag not in {"{" + IX + "}nonNumeric", "{" + IX + "}nonFraction", "{" + IX + "}fraction"}:
            continue
        text = "".join(node.itertext()).strip()
        original = {"attributes": dict(node.attrib), "text": text, "element": node.tag}
        originals.append(original)
        tag = qname(node.get("name"), scopes[id(node)])
        if local(tag) not in METRICS and local(tag) not in METADATA:
            continue
        if not re.fullmatch(r"\{http://www\.(?:bseindia\.com/xbrl/fin/\d{4}-\d{2}-\d{2}/in-bse-fin|sebi\.gov\.in/xbrl/\d{4}-\d{2}-\d{2}/in-capmkt)\}[A-Za-z0-9_]+", tag):
            problems.append({"tag": tag, "reason": "Unsupported BSE fact taxonomy"})
            continue
        fact = ET.SubElement(instance, tag, {k: v for k, v in node.attrib.items()
            if k in {"contextRef", "unitRef", "decimals", "{http://www.w3.org/2001/XMLSchema-instance}nil"}})
        try:
            if node.tag.endswith("}fraction") or any(node.get(k) for k in ("continuedAt", "tupleRef", "target")) or any(
                    n is not node and n.tag.startswith("{" + IX + "}") for n in node.iter()):
                raise ValueError("Unsupported compound Inline XBRL fact")
            fact.text = "" if fact.get("{http://www.w3.org/2001/XMLSchema-instance}nil") in {"true", "1"} else transform(text, node, scopes[id(node)])
        except ValueError as error:
            fact.text = "unsupported-inline-value"
            problems.append({"context": node.get("contextRef"), "tag": tag, "reason": str(error)})
    if not originals:
        raise ValueError("No supported Inline XBRL facts")
    parsed = parse_financial_xml(ET.tostring(instance), expected)
    parsed.update(inlineFacts=originals, inlineIssues=problems, adapter="bse-inline-1")
    parsed["sourceFormatNotes"] = ["BSE renderer's legacy numdotdecimalin spelling under the 2020 registry URI is parsed with strict Indian grouping; scale is explicit and decimals is precision."]
    if problems:
        for fact in parsed["facts"]:
            fact["eligible"] = False
            fact["issues"].append("unsupported-inline-transformation")
        parsed["dateIssues"].append("unsupported-inline-transformation")
    return parsed
