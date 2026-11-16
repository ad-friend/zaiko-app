"""指定された既存xlsxから値だけを標準ライブラリで読む。書き込みなし。"""
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

n = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
with zipfile.ZipFile(sys.argv[1]) as archive:
    shared = []
    if "xl/sharedStrings.xml" in archive.namelist():
        shared = ["".join(node.itertext()) for node in ET.fromstring(archive.read("xl/sharedStrings.xml"))]
    def sheet(number):
        doc = ET.fromstring(archive.read(f"xl/worksheets/sheet{number}.xml"))
        result = []
        for row in doc.find("m:sheetData", n):
            values = {}
            for cell in row:
                v = cell.find("m:v", n)
                if cell.attrib.get("t") == "inlineStr":
                    inline = cell.find("m:is", n)
                    value = "" if inline is None else "".join(inline.itertext())
                elif v is None:
                    value = None
                elif cell.attrib.get("t") == "s":
                    value = shared[int(v.text)]
                else:
                    value = float(v.text)
                key = "".join(c for c in cell.attrib["r"] if c.isalpha())
                values[key] = value
            result.append(values)
        return result
    print(json.dumps({"daily": sheet(1), "weekly": sheet(3), "stock": sheet(6)}, ensure_ascii=True))
