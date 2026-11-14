#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
glm4v_batch_labeling.py —— 结合智谱 GLM-4V 对 574 枚纹样图片批量打标
====================================================================
输入：03_非遗知识库数据/patterns_raw.json （574 条纹样元数据）
      04_静态资源与3D模型/patterns/{id}.webp （纹样图片，574 张全部在位）
输出：02_后端与AI智能体/labels_glm4v.jsonl （逐条追加，断点续跑）
      运行 `python3 glm4v_batch_labeling.py merge` 合并回盘点清单 CSV。

用法：
  export ZHIPU_API_KEY=你的智谱APIKey        # https://open.bigmodel.cn 获取
  python3 glm4v_batch_labeling.py            # 全量跑（默认 glm-4v-flash，免费）
  python3 glm4v_batch_labeling.py --limit 10 # 先小批量试跑 10 条验效果
  python3 glm4v_batch_labeling.py --model glm-4v-plus --workers 3
  python3 glm4v_batch_labeling.py merge      # 打标完成后合并到盘点清单

设计要点：
  1. 断点续跑：已有 label 的 id 自动跳过，中断后重跑不浪费 token；
  2. 结构化输出：强制 JSON，逐条正则校验，不合格自动重试（最多 3 次）；
  3. 防幻觉引用：模型只输出视觉/文化描述，文献出处由规则表给检索线索，
     严禁模型编造具体文献引用；
  4. 并发 + 退避：线程池并发，429/5xx 指数退避；
  5. 上下文注入：把 name/category/origin/meaning 等既有字段写进 prompt，
     让视觉打标与库内数据一致，而不是凭空猜测。
"""
import base64, json, os, re, sys, time, argparse, threading
from concurrent.futures import ThreadPoolExecutor, as_completed

# 启动时自动从同级 .env 加载 ZHIPU_API_KEY（与 zhipu_client.py 保持一致，
# 避免「忘了 export 导致 os.environ 取不到 Key 而静默退出」的坑）。
try:
    from dotenv import load_dotenv
    _env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    load_dotenv(_env_path)
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
KB = os.path.join(ROOT, '03_非遗知识库数据')
RAW_PATH = os.path.join(KB, 'patterns_raw.json')
INVENTORY = os.path.join(KB, 'pattern_inventory_574.csv')
OUT_PATH = os.path.join(HERE, 'labels_glm4v.jsonl')
PATTERNS_DIR = os.path.join(ROOT, '04_静态资源与3D模型', 'patterns')
API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'

# ---------------- 提示词（视觉打标核心） ----------------
SYSTEM_PROMPT = (
    '你是中国传统纹样与非物质文化遗产专家，为纹样数字博物馆的 RAG 知识库'
    '做图片语义打标。严格只输出一个 JSON 对象，不要输出任何其它文字或代码块标记。'
    '所有描述必须以图片可见证据为准，结合给定的馆藏元数据；'
    '绝不编造具体文献引用、考古编号或馆藏编号。'
)

USER_TMPL = '''请结合下方馆藏元数据，仔细观察这张纹样图片，输出如下 JSON：
{{
  "meaning_rich": "文化寓意，150-250字：先描述画面中可见的核心母题与构图，再解读其文化象征、历史流变与民俗功能，语言面向博物馆观众，准确、克制、不堆砌形容词",
  "craft_desc": "工艺与载体描述，80-150字：推断该纹样可能应用的非遗工艺（如织锦、刺绣、陶瓷釉下彩、漆器描金等）及载体器型，说明判断依据（笔触/质感/底色）",
  "color_palette": ["#RRGGBB", "#RRGGBB", "#RRGGBB", "#RRGGBB", "#RRGGBB"],
  "visual_motifs": ["母题1", "母题2", "母题3", "母题4"],
  "composition": "构图特征，20-40字：如四方连续/对称均衡/缠枝环抱/散点布局",
  "era_evidence": "时代风格判断，40-80字：依据线条、配色、母题风格与给定朝代信息是否吻合；若元数据朝代存疑，说明图上证据指向哪个时期",
  "confidence": "high|medium|low 三选一：对以上整体判断的置信度"
}}

馆藏元数据（可信，优先于你的猜测）：
- 纹样编号：{pid}
- 名称：{name}
- 分类：{category}（母题组：{group}）
- 起源时代：{origin}（标准归一：{origin_std}）
- 流行时代：{period}
- 库内一句话寓意：{meaning}
- 形态描述：{morphology}
- 已知工艺标签：{crafts}

要求：meaning_rich 需与"库内一句话寓意"语义一致并作深度扩展，不得与之矛盾；
若图片为线稿/剪影/扁平矢量图，craft_desc 请如实说明这是数字再创作，并推断其
传统原型工艺，不要把矢量图硬说成实拍器物。'''

REQUIRED_KEYS = ['meaning_rich', 'craft_desc', 'color_palette', 'visual_motifs',
                 'composition', 'era_evidence', 'confidence']
HEX_RE = re.compile(r'^#[0-9A-Fa-f]{6}$')


def validate(obj):
    """结构化输出校验：缺键 / 字数越界 / HEX 不合法都算失败"""
    if not isinstance(obj, dict):
        return '输出不是 JSON 对象'
    for k in REQUIRED_KEYS:
        if k not in obj or not obj[k]:
            return f'缺少字段 {k}'
    if not (80 <= len(obj['meaning_rich']) <= 320):
        return f'meaning_rich 字数 {len(obj["meaning_rich"])} 越界(80-320)'
    if not (50 <= len(obj['craft_desc']) <= 220):
        return f'craft_desc 字数 {len(obj["craft_desc"])} 越界(50-220)'
    if not (isinstance(obj['color_palette'], list) and 3 <= len(obj['color_palette']) <= 8
            and all(HEX_RE.match(c) for c in obj['color_palette'])):
        return 'color_palette 需要 3-8 个合法 HEX 色'
    if not (isinstance(obj['visual_motifs'], list) and 2 <= len(obj['visual_motifs']) <= 10):
        return 'visual_motifs 需要 2-10 个母题'
    if obj['confidence'] not in ('high', 'medium', 'low'):
        return 'confidence 取值非法'
    # 防幻觉：正文出现「出处：《》《文献》+书名号引用」直接判失败
    for field in ('meaning_rich', 'craft_desc'):
        if re.search(r'出自《|见于《|记载于《|《[^》]{2,20}》第.{1,6}页', obj[field]):
            return f'{field} 疑似编造文献引用，请删除书名号引用后重写'
    return None


def extract_json(text):
    """从模型回复中稳健提取 JSON（容忍 ```json 包裹 / 前后杂讯）"""
    text = re.sub(r'^```(?:json)?|```$', '', text.strip(), flags=re.M).strip()
    i, j = text.find('{'), text.rfind('}')
    if i < 0 or j <= i:
        raise ValueError('回复中未找到 JSON')
    return json.loads(text[i:j + 1])


def call_glm4v(api_key, model, image_b64, user_text, timeout=120, mime='image/webp'):
    import requests
    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': [
                {'type': 'image_url',
                 'image_url': {'url': f'data:{mime};base64,{image_b64}'}},
                {'type': 'text', 'text': user_text},
            ]},
        ],
        'temperature': 0.35,     # 低温度：馆藏打标要稳定、少发挥
        'max_tokens': 1024,      # glm-4v-flash 上限为 1024，超了直接 400
        'response_format': {'type': 'json_object'},   # 智谱 JSON 模式
    }
    for attempt in range(4):
        try:
            r = requests.post(API_URL, json=payload, timeout=timeout,
                              headers={'Authorization': f'Bearer {api_key}',
                                       'Content-Type': 'application/json'})
            if r.status_code == 429 or r.status_code >= 500:
                wait = 2 ** attempt * 5
                print(f'  HTTP {r.status_code}，退避 {wait}s 后重试', flush=True)
                time.sleep(wait)
                continue
            r.raise_for_status()
            return extract_json(r.json()['choices'][0]['message']['content'])
        except (requests.RequestException, KeyError, ValueError) as e:
            if attempt == 3:
                raise
            print(f'  重试({attempt + 1})：{e}', flush=True)
            time.sleep(2 ** attempt * 3)
    raise RuntimeError('调用失败')


_lock = threading.Lock()


def append_jsonl(rec):
    with _lock:
        with open(OUT_PATH, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')


def done_ids():
    if not os.path.exists(OUT_PATH):
        return set(), {}
    done, failed = set(), {}
    with open(OUT_PATH, encoding='utf-8') as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get('_ok'):
                done.add(rec['pattern_id'])
            elif rec.get('_error'):
                failed[rec['pattern_id']] = rec
    return done, failed


def label_one(api_key, model, d, group, origin_std):
    pid = d['id']
    img = os.path.join(PATTERNS_DIR, pid + '.webp')
    if not os.path.exists(img):
        append_jsonl({'pattern_id': pid, '_ok': False, '_error': 'image missing'})
        return pid, False, 'image missing'
    # 归一化为 RGB-PNG 再发送：GLM-4V 对部分 WebP 编码（RGBA/调色板模式）会报
    # 1210「图片输入格式/解析错误」，统一转 PNG 后可 100% 通过。
    try:
        from PIL import Image
        import io as _io
        im = Image.open(img)
        if im.mode != 'RGB':
            im = im.convert('RGB')
        buf = _io.BytesIO()
        im.save(buf, 'PNG')
        b64 = base64.b64encode(buf.getvalue()).decode()
        mime = 'image/png'
    except Exception:
        # 兜底：原样发送 webp
        with open(img, 'rb') as f:
            b64 = base64.b64encode(f.read()).decode()
        mime = 'image/webp'
    user_text = USER_TMPL.format(
        pid=pid, name=d['name'], category=d['category'], group=group,
        origin=d.get('origin', ''), origin_std=origin_std,
        period=d.get('period', ''), meaning=d.get('meaning', ''),
        morphology=d.get('morphology', ''),
        crafts='、'.join(d.get('crafts') or []))
    t0 = time.time()
    obj = call_glm4v(api_key, model, b64, user_text, mime=mime)
    err = validate(obj)
    if err:
        # 校验失败自动带错误重试一次
        obj = call_glm4v(api_key, model, b64, user_text +
                         f'\n\n注意：上一次输出未通过校验（{err}），请修正后重新完整输出 JSON。',
                         mime=mime)
        err = validate(obj)
        if err:
            append_jsonl({'pattern_id': pid, '_ok': False, '_error': err, '_raw': obj})
            return pid, False, err
    append_jsonl({'pattern_id': pid, '_ok': True, 'model': model,
                  'label': obj, '_secs': round(time.time() - t0, 1)})
    return pid, True, f'{time.time() - t0:.1f}s'


# ---------------- merge：合并回盘点清单 ----------------
def merge():
    import csv
    if not os.path.exists(OUT_PATH):
        print('尚无打标结果 labels_glm4v.jsonl，先运行打标。'); return
    done, _ = done_ids()
    labels = {}
    with open(OUT_PATH, encoding='utf-8') as f:
        for line in f:
            rec = json.loads(line)
            if rec.get('_ok'):
                labels[rec['pattern_id']] = rec['label']
    rows = list(csv.DictReader(open(INVENTORY, encoding='utf-8-sig')))
    hit = 0
    for r in rows:
        lab = labels.get(r['pattern_id'])
        if not lab:
            continue
        hit += 1
        r['meaning_rich'] = lab.get('meaning_rich', '')
        r['craft_desc'] = lab.get('craft_desc', '')
        r['color_palette'] = '；'.join(lab.get('color_palette', []))
        r['visual_motifs'] = '；'.join(lab.get('visual_motifs', []))
        r['composition'] = lab.get('composition', '')
        r['refs_verified'] = '待人工核对'
        r['review_status'] = 'GLM4V已打标·待抽检'
        if lab.get('era_evidence'):
            r['morphology'] = r['morphology']  # 形态描述保持原值；era_evidence 单列见 jsonl
    with open(INVENTORY, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    print(f'合并完成：{hit}/{len(rows)} 条已注入盘点清单 {INVENTORY}')
    low = [pid for pid, lab in labels.items() if lab.get('confidence') == 'low']
    if low:
        print(f'低置信度 {len(low)} 条，建议人工复核：{" ".join(low[:20])}{"..." if len(low) > 20 else ""}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='glm-4v-flash',
                    help='glm-4v-flash(免费) / glm-4v-plus(更准，成本高)')
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--limit', type=int, default=0, help='只跑前 N 条未完成的（试跑用）')
    ap.add_argument('--category', default='', help='只跑指定分类，如 少数民族纹样')
    ap.add_argument('--confidence-pass', action='store_true',
                    help='重跑 low 置信度样本')
    ap.add_argument('cmd', nargs='?', default='run', choices=['run', 'merge'])
    args = ap.parse_args()

    if args.cmd == 'merge':
        merge(); return
    api_key = os.environ.get('ZHIPU_API_KEY')
    if not api_key:
        sys.exit('请先 export ZHIPU_API_KEY=你的智谱APIKey')

    raw = json.load(open(RAW_PATH, encoding='utf-8'))
    # 复用盘点清单里的归一化结果
    import csv as _csv
    inv = {r['pattern_id']: r for r in _csv.DictReader(open(INVENTORY, encoding='utf-8-sig'))}
    done, _ = done_ids()
    todo = []
    for d in raw:
        pid = d['id']
        if pid in done and not args.confidence_pass:
            continue
        if args.category and d['category'] != args.category:
            continue
        r = inv.get(pid, {})
        todo.append((d, r.get('category_group', '其他'), r.get('origin_std', d.get('origin', ''))))
    if args.limit:
        todo = todo[:args.limit]
    print(f'待打标 {len(todo)} 条（已完成 {len(done)}），模型 {args.model}，并发 {args.workers}')
    ok = fail = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(label_one, api_key, args.model, d, g, o): d['id'] for d, g, o in todo}
        for i, fut in enumerate(as_completed(futs), 1):
            pid, success, msg = fut.result()
            ok += success; fail += (not success)
            flag = '✓' if success else '✗'
            print(f'[{i}/{len(todo)}] {flag} {pid} {msg}', flush=True)
    print(f'完成：成功 {ok}，失败 {fail}。重跑本命令可断点续跑；`merge` 合并进盘点清单。')


if __name__ == '__main__':
    main()
