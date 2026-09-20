"""Build data/cnf.json, data/usda.json and the app icons.

Runs in GitHub Actions on every push (see .github/workflows/pages.yml), so the
repository only needs to hold the app source. Sources:
  - Canadian Nutrient File 2026 (Health Canada, open.canada.ca)
  - USDA SR28 (files mirrored in github.com/masilver99/SR28-PSQL)
"""
import csv, io, json, os, urllib.request, zipfile

OUT = 'data'
os.makedirs(OUT, exist_ok=True)
WANT = {'208': 'kcal', '203': 'p', '205': 'c', '204': 'f', '291': 'fib', '269': 'sug', '307': 'na'}
# Micronutrients (USDA legacy nutrient numbers; CNF uses the same codes). Stored as index 11: [ca, fe, k, mg, zn, vd, b12, vc, fol]
MICRO = {'301': 'ca', '303': 'fe', '306': 'k', '304': 'mg', '309': 'zn', '328': 'vd', '418': 'b12', '401': 'vc', '417': 'fol'}
MICRO_ORDER = ['ca', 'fe', 'k', 'mg', 'zn', 'vd', 'b12', 'vc', 'fol']
MICRO_DEC = {'ca': 0, 'fe': 2, 'k': 0, 'mg': 0, 'zn': 2, 'vd': 2, 'b12': 2, 'vc': 1, 'fol': 0}
def micro_row(n):
    if not any(k in n for k in MICRO_ORDER): return []
    return [round(n.get(k, 0), MICRO_DEC[k]) for k in MICRO_ORDER]


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'plate-ledger-build/1.0'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def rows_csv(data):
    return list(csv.DictReader(io.StringIO(data.decode('utf-8-sig'), newline='')))


# ---------------- Canadian Nutrient File 2026 ----------------
def build_cnf():
    z = zipfile.ZipFile(io.BytesIO(fetch(
        'https://open.canada.ca/data/dataset/1b6139bd-ed7e-4043-bc28-ff00e10f3109/resource/019f2a90-e3a9-489d-b6e1-f74f4ba1d006/download/cnf_fcen_all-files-data_2026.zip')))
    names = {os.path.basename(n).lower(): n for n in z.namelist()}
    rd = lambda fn: rows_csv(z.read(names[fn.lower()]))
    groups = {r['CNF_Food_Group_Code']: r['CNF_Food_Group_Description_EN'] for r in rd('CNF_Food_Group.csv')}
    micro_codes = dict(MICRO); vd_iu = set()
    try:  # CNF nutrient codes match USDA for these, but resolve by name to be safe and note vitamin D units
        for r in rd('Nutrient_Name.csv'):
            nm = (r.get('Nutrient_Name') or r.get('Nutrient_Name_EN') or '').upper(); code = r['Nutrient_Code']; unit = (r.get('Nutrient_Unit') or '').lower()
            for key, pat in [('ca', 'CALCIUM'), ('fe', 'IRON'), ('k', 'POTASSIUM'), ('mg', 'MAGNESIUM'), ('zn', 'ZINC'), ('b12', 'VITAMIN B-12'), ('vc', 'VITAMIN C'), ('fol', 'FOLATE, TOTAL')]:
                if nm.startswith(pat) and code not in micro_codes: micro_codes[code] = key
            if nm.startswith('VITAMIN D') and ('D2' in nm or 'D3' in nm or unit in ('\u00b5g', 'ug', 'mcg')) and code not in micro_codes: micro_codes[code] = 'vd'
            if micro_codes.get(code) == 'vd' and unit == 'iu': vd_iu.add(code)
    except Exception as e:
        print('nutrient name lookup skipped:', e)
    nut = {}
    for r in rd('Nutrient_Amount.csv'):
        mk = micro_codes.get(r['Nutrient_Code'])
        if mk:
            try:
                v = float(r['Nutrient_Amount'])
                if r['Nutrient_Code'] in vd_iu: v = v / 40.0
                nut.setdefault(r['Food_Code'], {}).setdefault(mk, v)
            except ValueError: pass
        k = WANT.get(r['Nutrient_Code'])
        if k:
            try: nut.setdefault(r['Food_Code'], {})[k] = float(r['Nutrient_Amount'])
            except ValueError: pass
    meas = {r['Measure_Code']: r['Measure_Description_and_Unit_EN'] for r in rd('Measure_Name.csv')}
    wt = {}
    for r in rd('Measure_Weight_Conversion.csv'):
        if r['Measure_Type_Code'] == '3': continue  # refuse
        try: g = float(r['Measure_Weight_Conversion'])
        except ValueError: continue
        d = meas.get(r['Measure_Code'], '')
        if g <= 0 or not d or d.strip() == 'g': continue
        wt.setdefault(r['Food_Code'], []).append([d[:40], round(g, 1)])
    out = []
    for r in rd('Food_Name.csv'):
        fid, grp, name = r['Food_Code'], r['CNF_Food_Group_Code'], r['Food_Description_EN']
        if grp == '3': continue  # baby foods
        n = nut.get(fid, {})
        if 'kcal' not in n: continue
        g = lambda k: round(n.get(k, 0), 1)
        out.append([fid, name, grp, round(n['kcal']), g('p'), g('c'), g('f'), g('fib'), g('sug'), round(n.get('na', 0)), wt.get(fid, [])[:4], micro_row(n)])
    json.dump({'groups': groups, 'foods': out}, open(f'{OUT}/cnf.json', 'w'), separators=(',', ':'), ensure_ascii=False)
    print('CNF foods:', len(out))


# ---------------- USDA SR28 ----------------
def build_usda():
    base = 'https://raw.githubusercontent.com/masilver99/SR28-PSQL/master/'
    def rows(txt):
        for line in txt.decode('latin-1').splitlines():
            yield [c.strip('~') for c in line.rstrip('\r\n').split('^')]
    import py7zr
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        py7zr.SevenZipFile(io.BytesIO(fetch(base + 'NUT_DATA.7z'))).extractall(td)
        nut_txt = open(os.path.join(td, 'NUT_DATA.txt'), 'rb').read()
    groups = {r[0]: r[1] for r in rows(fetch(base + 'FD_GROUP.txt'))}
    nut = {}
    for r in rows(nut_txt):
        if r[1] in WANT:
            nut.setdefault(r[0], {})[WANT[r[1]]] = float(r[2])
        elif r[1] in MICRO:
            nut.setdefault(r[0], {})[MICRO[r[1]]] = float(r[2])
    wt = {}
    for r in rows(fetch(base + 'WEIGHT.txt')):
        fid, amt, desc, g = r[0], float(r[2]), r[3], float(r[4])
        if amt <= 0: continue
        label = (f'{amt:g} ' if amt != 1 else '') + desc
        wt.setdefault(fid, []).append([label[:40], round(g, 1)])
    out = []
    for r in rows(fetch(base + 'FOOD_DES.txt')):
        fid, grp, name = r[0], r[1], r[2]
        if grp == '0300': continue  # baby foods
        n = nut.get(fid, {})
        if 'kcal' not in n: continue
        g = lambda k: round(n.get(k, 0), 1)
        out.append([fid, name, grp, round(n['kcal']), g('p'), g('c'), g('f'), g('fib'), g('sug'), round(n.get('na', 0)), wt.get(fid, [])[:4], micro_row(n)])
    json.dump({'groups': groups, 'foods': out}, open(f'{OUT}/usda.json', 'w'), separators=(',', ':'))
    print('USDA foods:', len(out))


# ---------------- Icons ----------------
def build_icons():
    from PIL import Image, ImageDraw
    os.makedirs('icons', exist_ok=True)
    def icon(size):
        im = Image.new('RGBA', (size, size), (14, 124, 91, 255))
        d = ImageDraw.Draw(im)
        c = size / 2; R = size * 0.34; w = int(size * 0.075)
        d.ellipse([c - R, c - R, c + R, c + R], outline=(255, 255, 255, 255), width=w)
        d.ellipse([c - size * 0.08, c - size * 0.08, c + size * 0.08, c + size * 0.08], fill=(255, 255, 255, 255))
        mask = Image.new('L', (size, size), 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], int(size * 0.22), fill=255)
        im.putalpha(mask); return im
    icon(192).save('icons/icon-192.png'); icon(512).save('icons/icon-512.png')
    bg = Image.new('RGBA', (180, 180), (14, 124, 91, 255)); bg.alpha_composite(icon(180)); bg.convert('RGB').save('icons/apple-touch-icon.png')


if __name__ == '__main__':
    build_cnf()
    build_usda()
    build_icons()
