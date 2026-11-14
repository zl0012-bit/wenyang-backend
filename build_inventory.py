#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_inventory.py —— 纹样数据资产盘点清单生成器
------------------------------------------------------------
数据来源：01_前端源代码/assets/index-CmHYjBy8.js 内嵌的 574 枚纹样原始数组
         （已提取为 patterns_raw.json，字段与前端渲染逻辑完全一致）
输出：
  1) pattern_inventory_574.csv   全量盘点清单（含归一化字段 + GLM-4V 待填列）
  2) 纹样数据资产盘点清单.xlsx    三张工作表：字段字典 / 盘点清单 / 标签体系
  3) taxonomy.json               Agent 可用的结构化标签体系（含真实取值统计）
用法：python3 build_inventory.py
"""
import json, csv, re, os, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                       # 项目根目录
KB = os.path.join(ROOT, '03_非遗知识库数据')        # 知识库数据
RAW = os.path.join(KB, 'patterns_raw.json')
PATTERNS_DIR = os.path.join(ROOT, '04_静态资源与3D模型', 'patterns')

if not os.path.exists(RAW):
    raise SystemExit('缺少 patterns_raw.json（从主 bundle 提取的 574 条纹样数据）')

# ============================================================
# 一、清洗规则：origin / period 脏值归一化
#   现状：origin 有 67 种取值，period 有 59 种，其中混入了
#   民族名（苗族/彝族…）、宗教语境（道教/藏传佛教）、地域/项目名
#   （乐清细纹刻纸/四川自贡/望江/京绣）。规则：先分流，再归一。
# ============================================================

# 民族 →ethnic 字段（不参与朝代归一）
ETHNIC_RE = re.compile(
    r'苗族|彝族|壮族|白族|藏族|羌族|侗族|土家族|黎族|傣族|瑶族|花瑶|基诺族|纳西族|哈萨克族|维吾尔族')
ETHNIC_FIX = {'花瑶': '瑶族（花瑶支系）'}

# 宗教语境 →religion 字段
RELIGION_RE = re.compile(r'藏传佛教|道教|佛教')

# 地域 / 非遗项目名 →craft_origin_note 字段（不是朝代！）
PROJECT_RE = re.compile(r'乐清细纹刻纸|四川自贡|望江|京绣')

# 朝代归一表：(正则, (标准朝代, 时期大区))。顺序敏感：先具体后宽泛。
ERA_RULES = [
    (r'新石器|良渚|红山|大汶口|崧泽|马家窑|仰韶', '新石器时代', '先秦'),
    (r'商', '商', '先秦'),
    (r'西周中晚期|西周', '西周', '先秦'),
    (r'周代|周', '周', '先秦'),
    (r'春秋战国', '春秋战国', '先秦'),
    (r'春秋', '春秋', '先秦'),
    (r'战国', '战国', '先秦'),
    (r'西汉晚期|西汉中期|西汉早期|西汉', '西汉', '秦汉'),
    (r'东汉', '东汉', '秦汉'),
    (r'秦汉', '秦汉（跨）', '秦汉'),
    (r'秦', '秦', '秦汉'),
    (r'汉', '汉（泛指）', '秦汉'),
    (r'三国|魏晋|南北朝|北魏|北齐|北周|北朝|西魏|六朝', None, '魏晋南北朝'),  # None=保留原值
    (r'隋唐', '隋唐（跨）', '隋唐五代'),
    (r'隋代|隋', '隋', '隋唐五代'),
    (r'中唐|唐', '唐', '隋唐五代'),
    (r'五代', '五代', '隋唐五代'),
    (r'宋元明清', '宋元明清（跨）', '宋辽金元'),
    (r'唐宋', '唐宋（跨）', '宋辽金元'),
    (r'宋元', '宋元（跨）', '宋辽金元'),
    (r'宋代|宋', '宋', '宋辽金元'),
    (r'辽金|西夏|辽|金', '辽金西夏', '宋辽金元'),
    (r'元代|元', '元', '宋辽金元'),
    (r'明末清初|明清官窑|明清', '明清（跨）', '明清'),
    (r'明成化|明嘉靖|明代|明(?!清)', '明', '明清'),
    (r'清中期|清康熙|清代|清(?!明)', '清', '明清'),
    (r'民国|当代|现代|近现代', '近现代', '近现代'),
    (r'历代', '历代（跨期）', '历代'),
    (r'民间', '民间（历代）', '历代'),
]


def norm_era(raw):
    """返回 (ethnic, religion, project_note, origin_std, era_group)"""
    raw = (raw or '').strip()
    if not raw:
        return '', '', '', '待考', '待考'
    ethnic = ''
    m = ETHNIC_RE.search(raw)
    if m:
        ethnic = ETHNIC_FIX.get(m.group(0), m.group(0))
    m2 = RELIGION_RE.search(raw)
    religion = m2.group(0) if m2 else ''
    m3 = PROJECT_RE.search(raw)
    project = m3.group(0) if m3 else ''
    if ethnic or religion or project:
        # 民族 / 宗教 / 项目名混入朝代字段：朝代记为待考，另行标注
        return ethnic, religion, project, '待考', '待考'
    for pat, std, group in ERA_RULES:
        if re.search(pat, raw):
            return '', '', '', (std or raw), group
    return '', '', '', raw, '待考'


# ============================================================
# 二、分类映射：32 类原始分类 → 11 个标准母题组
# ============================================================
CATEGORY_GROUP = {
    '几何纹样': '几何', '动物纹样': '动物', '植物纹样': '植物',
    '吉祥符号纹': '吉祥符号', '吉祥组合纹': '吉祥符号',
    '人物纹样': '人物', '人物故事纹': '人物',
    '自然天象纹': '自然天象',
    '少数民族纹样': '少数民族',
    '敦煌专题': '敦煌与宗教', '石窟专题': '敦煌与宗教', '宗教艺术': '敦煌与宗教',
    '瓷器专题': '器物与建筑', '铜镜专题': '器物与建筑', '漆器专题': '器物与建筑',
    '瓦当专题': '器物与建筑', '画像砖专题': '器物与建筑', '建筑彩画': '器物与建筑',
    '家具专题': '器物与建筑', '玉器专题': '器物与建筑', '金银器专题': '器物与建筑',
    '铜器专题': '器物与建筑', '建筑与器物': '器物与建筑', '器物纹样': '器物与建筑',
    '综合装饰': '器物与建筑', '边饰纹样': '器物与建筑',
    '刺绣纹样': '织绣印染剪纸', '织绣专题': '织绣印染剪纸',
    '印染专题': '织绣印染剪纸', '剪纸专题': '织绣印染剪纸',
    '官服纹样': '其他', '其他类': '其他',
}

# ============================================================
# 三、文献线索规则表（真实通史/图录类书目，仅作检索线索，
#     版次需人工核对 —— 绝不让大模型编造引用）
# ============================================================
REF_RULES = [
    (r'几何|回纹|云纹|雷纹', '田自秉、吴淑生、田青《中国纹样史》；《中国历代装饰纹样》'),
    (r'动物|龙|凤|饕餮|夔', '田自秉等《中国纹样史》；《中国青铜器全集》；《中国美术全集·工艺美术编》'),
    (r'植物|莲|牡丹|缠枝|宝相', '田自秉等《中国纹样史》；《中国陶瓷史》（中国硅酸盐学会编）'),
    (r'吉祥', '田自秉等《中国纹样史》（吉祥寓意章）；王抗生《中国吉祥图》类图录（核对版次）'),
    (r'人物|故事', '《中国美术全集·绘画编》；郑振铎《中国古代版画丛刊》类文献（核对）'),
    (r'天象|云|星|日|月', '田自秉等《中国纹样史》；闻一多《伏羲考》等神话学文献（核对）'),
    (r'敦煌|石窟|宗教|佛|道', '《敦煌石窟全集》；《中国敦煌历代装饰图案》（核对版次）'),
    (r'瓷器|瓷', '《中国陶瓷史》（中国硅酸盐学会编，文物出版社）；《中国美术全集·陶瓷编》'),
    (r'铜镜', '《中国铜镜图典》（核对版次）；孔祥星、刘一曼《中国古代铜镜》'),
    (r'漆器', '王世襄《髹饰录解说》；《中国美术全集·漆器编》'),
    (r'瓦当', '《中国古代瓦当图典》类图录（核对版次）'),
    (r'画像砖', '《四川汉代画像砖》等区域图录（核对版次）；《中国美术全集·画像石画像砖编》'),
    (r'剪纸', '《中国民间剪纸全集》类图录（核对版次）'),
    (r'建筑|彩画', '马瑞田《中国古建筑彩画》类专著（核对版次）'),
    (r'家具', '王世襄《明式家具研究》'),
    (r'玉器', '《中国玉器全集》（河北美术出版社）'),
    (r'金银器', '《中国金银玻璃珐琅器全集》（河北美术出版社）'),
    (r'刺绣|织绣|织锦|印染|缂丝', '《中国织绣服饰全集》；赵丰《中国丝绸艺术史》'),
    (r'苗族|彝|壮|白族|藏|羌|侗|土家|黎|傣|瑶|基诺|纳西|哈萨克|维吾尔',
     '《中国少数民族服饰》类图录；杨源等编民族服饰专志（核对版次）'),
    (r'官服|补子', '沈从文《中国古代服饰研究》；《清代补子图集》类图录（核对）'),
]
DEFAULT_REF = '田自秉等《中国纹样史》；《中国美术全集》（按工艺分卷检索）'


def suggest_refs(name, category, ethnic):
    key = name + category + (ethnic or '')
    for pat, refs in REF_RULES:
        if re.search(pat, key):
            return refs
    return DEFAULT_REF


# ============================================================
# 四、朝代主题：与前端 He() 正则保持一致（同一套规则的两端实现）
# ============================================================
def dynasty_theme(origin_raw, ethnic):
    e = origin_raw or ''
    if re.search(r'新石器|商|周|良渚|红山|大汶口|崧泽|马家窑|青铜|彩陶', e):
        return 'shangzhou（商周·青铜绿）'
    if re.search(r'春秋|战国|秦|汉|隋|魏晋|南北朝|六朝|唐|隋唐', e):
        return 'hantang（汉唐·富丽金）'
    if re.search(r'宋|元|辽|金|西夏', e):
        return 'songyuan（宋元·雅致青）'
    if re.search(r'明|清|民国|当代|现代', e):
        return 'mingqing（明清·繁缛红）'
    if ethnic:  # 前端行为：民族纹样落到明清主题
        return 'mingqing（明清·繁缛红）'
    return 'mingqing（明清·繁缛红）'


# ============================================================
# 五、生成盘点清单
# ============================================================
def build_rows(raw):
    rows = []
    for d in raw:
        pid = d['id']
        img_local = os.path.join(PATTERNS_DIR, pid + '.webp')
        ethnic, religion, project, origin_std, era_group = norm_era(d.get('origin', ''))
        # period 单独再跑一遍归一（origin 里的民族标签不重复计入）
        _, _, _, period_std, period_group = norm_era(re.sub(ETHNIC_RE, '', d.get('period', '') or '').strip() or d.get('period', ''))
        if period_std == '待考' and d.get('period'):
            period_std, period_group = norm_era(d['period'])[3], norm_era(d['period'])[4]
        rows.append({
            'pattern_id': pid,
            'name': d['name'],
            'category_raw': d['category'],
            'category_group': CATEGORY_GROUP.get(d['category'], '其他'),
            'origin_raw': d.get('origin', ''),
            'period_raw': d.get('period', ''),
            'origin_std': origin_std,
            'period_std': period_std,
            'era_group': era_group if era_group != '待考' else (period_group if period_group != '待考' else '待考'),
            'ethnic': ethnic,
            'religion': religion,
            'craft_origin_note': project,
            'dynasty_theme': dynasty_theme(d.get('origin', ''), ethnic),
            'crafts': '；'.join(d.get('crafts') or []),
            'morphology': d.get('morphology', ''),
            'meaning_short': d.get('meaning', ''),
            'meaning_rich': '',      # ← GLM-4V 待生成
            'craft_desc': '',        # ← GLM-4V 待生成
            'color_palette': '',     # ← GLM-4V 待生成（HEX 数组）
            'visual_motifs': '',     # ← GLM-4V 待生成
            'composition': '',       # ← GLM-4V 待生成
            'refs_suggested': suggest_refs(d['name'], d['category'], ethnic),
            'refs_verified': '待人工核对',
            'image_url': f'/patterns/{pid}.webp',
            'image_path': img_local,
            'image_status': '存在' if os.path.exists(img_local) else '缺失',
            'ai_prompt': d.get('aiPrompt', ''),
            'chunk_id': f'pattern::{pid}',
            'review_status': '已归一化·待复核',
        })
    return rows


FIELDS = ['pattern_id', 'name', 'category_raw', 'category_group', 'origin_raw', 'period_raw',
          'origin_std', 'period_std', 'era_group', 'ethnic', 'religion', 'craft_origin_note',
          'dynasty_theme', 'crafts', 'morphology', 'meaning_short',
          'meaning_rich', 'craft_desc', 'color_palette', 'visual_motifs', 'composition',
          'refs_suggested', 'refs_verified', 'image_url', 'image_path', 'image_status',
          'ai_prompt', 'chunk_id', 'review_status']

FIELD_DICT = [
    # 字段, 类型, 来源, 必填, 说明 / RAG 用途
    ('pattern_id',   'string',  '现有数据库', '是',  '纹样唯一 ID（如 A01），与 /patterns/{id}.webp 对应；RAG chunk 主键'),
    ('name',         'string',  '现有数据库', '是',  '纹样名称；向量检索高频查询词'),
    ('category_raw', 'string',  '现有数据库', '是',  '前端 32 类原始分类'),
    ('category_group','string', '清洗归一',   '是',  '11 个标准母题组（见「标签体系」表）；Agent 过滤维度'),
    ('origin_raw',   'string',  '现有数据库', '是',  '起源时代原始值（67 种脏取值，仅存档）'),
    ('period_raw',   'string',  '现有数据库', '是',  '流行时代原始值（59 种脏取值，仅存档）'),
    ('origin_std',   'enum',    '清洗归一',   '是',  '标准朝代（见规范枚举）；「待考」= 民族/宗教/地域混入需人工'),
    ('period_std',   'enum',    '清洗归一',   '是',  '标准流行朝代；跨期用「跨」标记（如 明清（跨））'),
    ('era_group',    'enum',    '清洗归一',   '是',  '时期大区：先秦/秦汉/魏晋南北朝/隋唐五代/宋辽金元/明清/近现代/历代/待考'),
    ('ethnic',       'string',  '清洗归一',   '否',  '所属民族（自 origin/period 中分流出来）；民族纹样必填'),
    ('religion',     'string',  '清洗归一',   '否',  '宗教语境（道教/佛教/藏传佛教）'),
    ('craft_origin_note', 'string', '清洗归一', '否', '地域/非遗项目名（乐清细纹刻纸、京绣等），不是朝代'),
    ('dynasty_theme','enum',    '前端映射',   '是',  '前端四大朝代主题 shangzhou/hantang/songyuan/mingqing（与 He() 一致）'),
    ('crafts',       'string[]','现有数据库', '是',  '非遗工艺标签（分号分隔）'),
    ('morphology',   'text',    '现有数据库', '是',  '形态描述（现有）'),
    ('meaning_short','text',    '现有数据库', '是',  '一句话寓意（现有）'),
    ('meaning_rich', 'text',    'GLM-4V 生成', '是', '150-250 字深度文化寓意（视觉证据+文化常识），RAG 核心语料'),
    ('craft_desc',   'text',    'GLM-4V 生成', '是', '80-150 字工艺与载体描述'),
    ('color_palette','string[]','GLM-4V 生成','是', '5 个主色 HEX（正则校验 #[0-9A-F]{6}）'),
    ('visual_motifs','string[]','GLM-4V 生成','是', '视觉母题词表（Agent 检索键）'),
    ('composition',  'text',    'GLM-4V 生成', '否', '构图特征（连续/对称/四方连续等）'),
    ('refs_suggested','text',   '规则表',     '是',  '推荐检索文献/图录（真实书目，版次待核对；禁止大模型生成）'),
    ('refs_verified','enum',    '人工',       '否',  '文献核对状态：待人工核对/已核对（含版次页码）'),
    ('image_url',    'string',  '现有数据库', '是',  '图片 URL（/patterns/{id}.webp）'),
    ('image_path',   'string',  '现有数据库', '是',  '本地图片路径（GLM-4V 输入）'),
    ('image_status', 'enum',    '清洗归一',   '是',  '存在/缺失'),
    ('ai_prompt',    'text',    '现有数据库', '是',  'AIGC 生图提示词（现有）'),
    ('chunk_id',     'string',  '清洗归一',   '是',  'RAG 块 ID：pattern::{id}'),
    ('review_status','enum',    '清洗归一',   '是',  '清洗状态：已归一化·待复核/复核通过/复核驳回'),
]


def build_taxonomy(rows, raw):
    from collections import Counter
    return {
        'meta': {'total_patterns': len(rows), 'generated': '基于 patterns_raw.json 真实数据统计'},
        'category_groups': dict(Counter(r['category_group'] for r in rows)),
        'category_raw': {c: n for c, n in Counter(r['category_raw'] for r in rows).most_common()},
        'era_groups': dict(Counter(r['era_group'] for r in rows)),
        'origin_std': {c: n for c, n in Counter(r['origin_std'] for r in rows).most_common()},
        'ethnic': {c: n for c, n in Counter(r['ethnic'] for r in rows if r['ethnic']).most_common()},
        'crafts_vocab': sorted({c.strip() for r in rows for c in r['crafts'].split('；') if c.strip()}),
        'dynasty_themes': dict(Counter(r['dynasty_theme'].split('（')[0] for r in rows)),
        }


def main():
    raw = json.load(open(RAW, encoding='utf-8'))
    rows = build_rows(raw)
    # 复核统计
    ka = sum(1 for r in rows if r['origin_std'] == '待考')
    print(f"共 {len(rows)} 条；origin/period 归一后『待考』{ka} 条（民族/宗教/地域混入，需人工）")
    # CSV
    csv_path = os.path.join(KB, 'pattern_inventory_574.csv')
    with open(csv_path, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    print('已写出', csv_path)
    # taxonomy.json
    tax = build_taxonomy(rows, raw)
    json.dump(tax, open(os.path.join(KB, 'taxonomy.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('已写出 taxonomy.json')
    # Excel（三张表）
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment
        from openpyxl.utils import get_column_letter
    except ImportError:
        print('openpyxl 未安装，跳过 Excel 输出'); return
    wb = Workbook()
    # Sheet1 字段字典
    ws = wb.active; ws.title = '字段字典'
    header_fill = PatternFill('solid', fgColor='7E2129')
    for j, h in enumerate(['字段', '类型', '数据来源', '必填', '说明 / RAG 用途'], 1):
        c = ws.cell(1, j, h); c.font = Font(bold=True, color='FFFFFF'); c.fill = header_fill
        c.alignment = Alignment(horizontal='center')
    for i, row in enumerate(FIELD_DICT, 2):
        for j, v in enumerate(row, 1):
            ws.cell(i, j, v)
    for j, wdt in enumerate([20, 10, 12, 8, 80], 1):
        ws.column_dimensions[get_column_letter(j)].width = wdt
    ws.freeze_panes = 'A2'
    # Sheet2 盘点清单
    ws2 = wb.create_sheet('盘点清单(574)')
    zh = {'pattern_id': '纹样ID', 'name': '名称', 'category_raw': '原始分类', 'category_group': '母题组',
          'origin_raw': '起源时代(原始)', 'period_raw': '流行时代(原始)', 'origin_std': '起源时代(标准)',
          'period_std': '流行时代(标准)', 'era_group': '时期大区', 'ethnic': '民族', 'religion': '宗教语境',
          'craft_origin_note': '地域/项目', 'dynasty_theme': '朝代主题', 'crafts': '非遗工艺',
          'morphology': '形态描述', 'meaning_short': '简要寓意', 'meaning_rich': '文化寓意·GLM4V',
          'craft_desc': '工艺描述·GLM4V', 'color_palette': '色彩HEX·GLM4V', 'visual_motifs': '视觉母题·GLM4V',
          'composition': '构图·GLM4V', 'refs_suggested': '关联文献(线索)', 'refs_verified': '文献核对状态',
          'image_url': '图片URL', 'image_path': '本地路径', 'image_status': '图片状态',
          'ai_prompt': '生图提示词', 'chunk_id': 'RAG块ID', 'review_status': '清洗状态'}
    for j, f in enumerate(FIELDS, 1):
        c = ws2.cell(1, j, zh.get(f, f)); c.font = Font(bold=True, color='FFFFFF'); c.fill = header_fill
        c.alignment = Alignment(horizontal='center')
    for i, r in enumerate(rows, 2):
        for j, f in enumerate(FIELDS, 1):
            ws2.cell(i, j, r[f])
    widths = [9, 12, 11, 12, 12, 12, 12, 12, 11, 8, 8, 11, 20, 16, 30, 20, 30, 30, 16, 16, 12, 34, 10, 18, 24, 8, 30, 14, 12]
    for j, wdt in enumerate(widths, 1):
        ws2.column_dimensions[get_column_letter(j)].width = wdt
    ws2.freeze_panes = 'C2'
    ws2.auto_filter.ref = f'A1:{get_column_letter(len(FIELDS))}1'
    # Sheet3 标签体系
    ws3 = wb.create_sheet('标签体系')
    r_ = 1
    def section(title, pairs):
        nonlocal r_
        c = ws3.cell(r_, 1, title); c.font = Font(bold=True, color='FFFFFF'); c.fill = header_fill
        ws3.cell(r_, 2, '取值 / 统计').font = Font(bold=True, color='FFFFFF')
        ws3.cell(r_, 2).fill = header_fill
        r_ += 1
        for k, v in pairs:
            ws3.cell(r_, 1, str(k)); ws3.cell(r_, 2, str(v)); r_ += 1
        r_ += 1
    section('一、母题组（category_group，11 组）', sorted(tax['category_groups'].items(), key=lambda x: -x[1]))
    section('二、时期大区（era_group）', sorted(tax['era_groups'].items(), key=lambda x: -x[1]))
    section('三、朝代主题（dynasty_theme，与前端一致）', sorted(tax['dynasty_themes'].items()))
    section('四、民族标签（ethnic）', sorted(tax['ethnic'].items(), key=lambda x: -x[1]))
    section('五、工艺词表（crafts_vocab，Agent 可检索）', [(k, '') for k in tax['crafts_vocab']])
    section('六、原始 32 类 → 计数', tax['category_raw'].items())
    ws3.column_dimensions['A'].width = 34; ws3.column_dimensions['B'].width = 52
    xlsx = os.path.join(KB, '纹样数据资产盘点清单.xlsx')
    wb.save(xlsx)
    print('已写出', xlsx)


if __name__ == '__main__':
    main()
