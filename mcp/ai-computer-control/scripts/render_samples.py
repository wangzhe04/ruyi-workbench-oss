"""render_samples.py — 一键生成三风格 Office 样例 12 件套 (v1.7「Office 体系 2.0」; v1.7.1 起
minimal/vibrant 各有独立版式个性 + 图表带 X/Y 轴标题).

把关人将逐件用 Word / Excel / PowerPoint 的 COM 导图过「审美关」。此脚本用 v1.7 升级后的 4 个生成工具
(write_document / write_excel + excel_beautify + excel_chart / write_pptx / chart_image) 把三套设计系统
(business「青花商务」/ minimal「墨白极简」/ vibrant「活力现代」) 各渲染成一整套代表性产物:

  每个风格 4 件:
    sample_<style>.docx  — 封面(深底满铺 + 金/强调线) + H1/H2/H3 + 正文 + 项目符号 + 内嵌样式表格 + 页码
    sample_<style>.xlsx  — write_excel 落笔即样式 (token 字体 + 数字格式) → excel_beautify 全美化 → 内嵌图表
    sample_<style>.pptx  — 封面 + content(3条/8条) + stats 数字卡 + table + closing 全版式
    sample_<style>.png   — chart_image 独立配色柱状图 (token 调色板 + 中文字体)

  3 风格 × 4 件 = 12 件套。文件名 sample_<style>.<ext>,全中文内容。

用法:
    python -X utf8 scripts/render_samples.py [输出目录]
    输出目录缺省 = <系统临时目录>/acc_samples_v17

退出码 0 = 12 件全部生成且非空;否则非零并打印失败项。
"""

import os
import sys
import tempfile

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, "src"))

# Give the audit log a writable data dir so @mcp.tool(audit=True) tools don't touch a system path.
os.environ.setdefault("WCW_DATA_DIR", os.path.join(tempfile.gettempdir(), "acc_samples_v17_data"))
os.makedirs(os.environ["WCW_DATA_DIR"], exist_ok=True)

import ai_computer_control.server as server  # noqa: E402
from ai_computer_control.tools import office_style as tokens  # noqa: E402

_FNS = {t.name: t.fn for t in server.mcp._tool_manager.list_tools()}

STYLES = ["business", "minimal", "vibrant"]


def _docx(style: str, out_dir: str) -> str:
    """封面 + 多级标题 + 正文 + 项目符号 + 内嵌表格 + 页码。"""
    name = tokens.get_style(style)["name"]
    path = os.path.join(out_dir, f"sample_{style}.docx")
    content = (
        "# 一、季度经营综述\n"
        "本季度公司整体经营稳中向好，营业收入与利润双双实现同比增长，"
        "核心业务的 English 关键词（如 ARR、NPS）在报告中与中文混排，用于验证字体统一。\n"
        "## 1.1 收入结构\n"
        "华东、华南、华北三大区域协同发力，线上渠道占比持续提升。\n"
        "- 华东区连续三个季度领跑\n"
        "- 华南区新客户增速最快\n"
        "- 华北区利润率行业领先\n"
        "### 1.1.1 关键指标\n"
        "以下为本季度关键指标明细：\n"
        "TABLE: 季度 | 销售额(万元) | 同比增长 | 客户数\n"
        "| 第一季度 | 1250 | 12% | 1240\n"
        "| 第二季度 | 1580 | 26% | 1560\n"
        "| 第三季度 | 1420 | -10% | 1490\n"
        "| 第四季度 | 1890 | 33% | 2100\n"
        "\n"
        "# 二、下季度展望\n"
        "锁定冲刺目标，强化供应链二级备份，推进数据看板 2.0 与合规审计整改。\n"
    )
    r = _FNS["write_document"](
        path=path,
        content=content,
        title=f"如意 年度业务报告 · {name}",
        style=style,
        cover={
            "title": f"如意 季度经营报告",
            "subtitle": f"{name} · 2026 财年第一季度",
            "date": "2026-07-05",
            "author": "把关人",
        },
        page_numbers=True,
    )
    if not r.get("success"):
        raise RuntimeError(f"docx[{style}] 失败: {r}")
    return path


def _xlsx(style: str, out_dir: str) -> str:
    """write_excel 落笔即样式 → excel_beautify 全美化 → excel_chart 内嵌图表。"""
    path = os.path.join(out_dir, f"sample_{style}.xlsx")
    headers = ["区域", "销售额", "同比增长", "客户数", "毛利率"]
    data = [
        ["华东区", "1250000", "12%", "1240", "41%"],
        ["华南区", "980000", "-5%", "890", "38%"],
        ["华北区", "2100000", "33%", "2100", "44%"],
        ["西南区", "760000", "8%", "650", "36%"],
        ["东北区", "540000", "-3%", "430", "33%"],
    ]
    r = _FNS["write_excel"](path=path, headers=headers, data=data, style=style)
    if not r.get("success"):
        raise RuntimeError(f"xlsx.write[{style}] 失败: {r}")
    rb = _FNS["excel_beautify"](path=path, style=style)
    if not rb.get("success"):
        raise RuntimeError(f"xlsx.beautify[{style}] 失败: {rb}")
    # chart over 区域 vs 销售额 (A1:B6), anchored clear of the data.
    # v1.7.1: 轴标题 — x 走自动推导 (首列表头「区域」)，y 显式带单位「销售额(元)」(用户反馈图表缺轴单位).
    rc = _FNS["excel_chart"](path=path, sheet="Sheet1", chart_type="bar",
                             data_range="A1:B6", title="各区域销售额", target_cell="H2",
                             y_title="销售额(元)")
    if not rc.get("success"):
        raise RuntimeError(f"xlsx.chart[{style}] 失败: {rc}")
    return path


def _pptx(style: str, out_dir: str) -> str:
    """封面 + content(3条) + content(8条自动两栏) + stats 卡片 + table + closing 全版式。"""
    name = tokens.get_style(style)["name"]
    path = os.path.join(out_dir, f"sample_{style}.pptx")
    slides = [
        {"type": "title", "title": "季度业绩汇报",
         "subtitle": f"{name} · 2026 财年第一季度", "date": "2026-07-05"},
        {"type": "content", "title": "核心要点", "bullets": [
            "销售额同比增长 26%，创同期新高",
            {"text": "华东区连续三季领跑", "level": 1},
            "第四季度冲刺目标已锁定"]},
        {"type": "content", "title": "推进事项", "bullets": [
            "完成年度预算复盘", "上线新版客户门户", "华南区团队扩编",
            "供应链二级备份", "季度 OKR 对齐会", "老客户续约专项",
            "数据看板 2.0", "合规审计整改"]},
        {"type": "stats", "title": "关键指标", "items": [
            {"label": "营业收入", "value": "¥18.9M", "note": "同比 +33%"},
            {"label": "新增客户", "value": "1,240", "note": "环比 +12%"},
            {"label": "毛利率", "value": "41.2%"},
            {"label": "客户 NPS", "value": "62", "note": "行业前 10%"}]},
        {"type": "table", "title": "季度明细", "headers": ["季度", "销售额", "增长"],
         "rows": [["第一季度", "1250", "12%"], ["第二季度", "1580", "26%"],
                  ["第三季度", "1420", "-10%"], ["第四季度", "1890", "33%"]]},
        {"type": "closing", "title": "谢谢", "subtitle": "欢迎交流与指正"},
    ]
    r = _FNS["write_pptx"](path=path, slides=slides, style=style)
    if not r.get("success"):
        raise RuntimeError(f"pptx[{style}] 失败: {r}")
    return path


def _png(style: str, out_dir: str) -> str:
    """chart_image 独立配色柱状图 (token 调色板 + 中文标题/标签)。"""
    path = os.path.join(out_dir, f"sample_{style}.png")
    data = {
        "labels": ["第一季度", "第二季度", "第三季度", "第四季度"],
        "series": [
            {"name": "销售额", "values": [1250, 1580, 1420, 1890]},
            {"name": "利润", "values": [320, 410, 380, 520]},
        ],
    }
    # v1.7.1: 轴标题带单位 (多系列 y 不自动推导，显式给「金额(万元)」).
    r = _FNS["chart_image"](path=path, chart_type="bar", data=data,
                            title="季度销售额与利润", style=style,
                            x_title="季度", y_title="金额(万元)")
    if not r.get("success"):
        raise RuntimeError(f"png[{style}] 失败: {r}")
    return path


def main() -> int:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        tempfile.gettempdir(), "acc_samples_v17")
    os.makedirs(out_dir, exist_ok=True)

    made: list[str] = []
    failures: list[str] = []

    for style in STYLES:
        for label, fn in (("docx", _docx), ("xlsx", _xlsx),
                          ("pptx", _pptx), ("png", _png)):
            try:
                p = fn(style, out_dir)
                size = os.path.getsize(p) if os.path.exists(p) else 0
                if size <= 0:
                    failures.append(f"{style}.{label}: 文件为空或不存在 ({p})")
                else:
                    made.append(p)
                    print(f"  [ok] {os.path.basename(p):24s} {size:>8d} bytes")
            except Exception as e:  # noqa: BLE001
                failures.append(f"{style}.{label}: {e}")
                print(f"  [FAIL] {style}.{label}: {e}")

    print()
    print(f"输出目录: {out_dir}")
    print(f"生成 {len(made)}/12 件。")
    if failures:
        print("失败项:")
        for f in failures:
            print("  -", f)
        return 1
    print("RENDER SAMPLES: ALL 12 GENERATED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
