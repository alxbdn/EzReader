use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use subsetter::GlyphRemapper;

pub const FAMILIES: [&str; 40] = [
    "Arial",
    "Arial Black",
    "Verdana",
    "Tahoma",
    "Trebuchet MS",
    "Georgia",
    "Times New Roman",
    "Courier New",
    "Comic Sans MS",
    "Impact",
    "Palatino Linotype",
    "Book Antiqua",
    "Garamond",
    "Century Gothic",
    "Franklin Gothic Medium",
    "Lucida Console",
    "Segoe UI",
    "Calibri",
    "Cambria",
    "Candara",
    "Consolas",
    "Constantia",
    "Corbel",
    "Helvetica Neue",
    "Avenir Next",
    "Futura",
    "Gill Sans",
    "Optima",
    "Baskerville",
    "Menlo",
    "Aptos",
    "Calibri Light",
    "Arial Narrow",
    "Century Schoolbook",
    "Bookman Old Style",
    "Lucida Sans Unicode",
    "Microsoft Sans Serif",
    "Myriad Pro",
    "Roboto",
    "Open Sans",
];

const FILE_ALIASES: [&str; 9] = ["ariblk", "trebuc", "pala", "bkant", "gara", "gothic", "framd", "lucon", "l10646"];

const NAME_FAMILY: u16 = 1;
const NAME_SUBFAMILY: u16 = 2;
const NAME_POST_SCRIPT: u16 = 6;
const NAME_TYPO_FAMILY: u16 = 16;
const NAME_TYPO_SUBFAMILY: u16 = 17;

fn u16_be(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_be_bytes(b.get(off..off.checked_add(2)?)?.try_into().ok()?))
}

fn i16_be(b: &[u8], off: usize) -> Option<i16> {
    Some(i16::from_be_bytes(b.get(off..off.checked_add(2)?)?.try_into().ok()?))
}

fn u32_be(b: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(off..off.checked_add(4)?)?.try_into().ok()?))
}

fn i32_be(b: &[u8], off: usize) -> Option<i32> {
    Some(i32::from_be_bytes(b.get(off..off.checked_add(4)?)?.try_into().ok()?))
}

fn fonts_in_collection(data: &[u8]) -> Option<u32> {
    (data.get(0..4) == Some(b"ttcf")).then(|| u32_be(data, 8)).flatten()
}

struct Face<'a> {
    data: &'a [u8],
    dir: usize,
    num_tables: usize,
    upem: u16,
}

impl<'a> Face<'a> {
    fn parse(data: &'a [u8], index: u32) -> Option<Self> {
        let dir = if data.get(0..4) == Some(b"ttcf") {
            let count = u32_be(data, 8)?;
            if index >= count {
                return None;
            }
            usize::try_from(u32_be(data, 12usize.checked_add((index as usize).checked_mul(4)?)?)?).ok()?
        } else if index == 0 {
            0
        } else {
            return None;
        };
        if !matches!(data.get(dir..dir.checked_add(4)?)?, [0, 1, 0, 0] | b"OTTO" | b"true" | b"typ1") {
            return None;
        }
        let num_tables = u16_be(data, dir + 4)? as usize;
        if dir.checked_add(12usize.checked_add(num_tables.checked_mul(16)?)?)? > data.len() {
            return None;
        }
        let mut f = Face { data, dir, num_tables, upem: 1000 };
        let upem = u16_be(f.table(b"head")?, 18)?;
        if !(16..=16384).contains(&upem) || f.table(b"hhea")?.len() < 36 || f.table(b"maxp")?.len() < 6 {
            return None;
        }
        f.upem = upem;
        Some(f)
    }

    fn table(&self, tag: &[u8; 4]) -> Option<&'a [u8]> {
        for i in 0..self.num_tables {
            let rec = self.dir + 12 + i * 16;
            if self.data.get(rec..rec + 4) == Some(tag) {
                let off = usize::try_from(u32_be(self.data, rec + 8)?).ok()?;
                let len = usize::try_from(u32_be(self.data, rec + 12)?).ok()?;
                return self.data.get(off..off.checked_add(len)?);
            }
        }
        None
    }

    fn has_cff(&self) -> bool {
        self.table(b"CFF ").is_some() || self.table(b"CFF2").is_some()
    }

    #[cfg(test)]
    fn has_glyf(&self) -> bool {
        self.table(b"glyf").is_some()
    }

    fn names(&self, id: u16) -> Vec<String> {
        let Some(t) = self.table(b"name") else { return Vec::new() };
        let (Some(count), Some(storage)) = (u16_be(t, 2), u16_be(t, 4)) else { return Vec::new() };
        let storage = storage as usize;
        let mut out = Vec::new();
        for i in 0..count as usize {
            let rec = 6 + i * 12;
            let (Some(platform), Some(encoding), Some(nid), Some(len), Some(off)) =
                (u16_be(t, rec), u16_be(t, rec + 2), u16_be(t, rec + 6), u16_be(t, rec + 8), u16_be(t, rec + 10))
            else {
                continue;
            };
            if nid != id {
                continue;
            }
            let Some(start) = storage.checked_add(off as usize) else { continue };
            let Some(end) = start.checked_add(len as usize) else { continue };
            let Some(bytes) = t.get(start..end) else { continue };
            if platform == 0 || (platform == 3 && matches!(encoding, 0 | 1 | 10)) {
                let (pairs, rem) = bytes.as_chunks::<2>();
                if rem.is_empty() {
                    let u16s: Vec<u16> = pairs.iter().copied().map(u16::from_be_bytes).collect();
                    if let Ok(s) = String::from_utf16(&u16s) {
                        out.push(s);
                    }
                }
            } else if platform == 1 && encoding == 0 && bytes.is_ascii() {
                if let Ok(s) = std::str::from_utf8(bytes) {
                    out.push(s.to_owned());
                }
            }
        }
        out
    }

    fn is_bold(&self) -> bool {
        self.table(b"OS/2").and_then(|t| u16_be(t, 62)).is_some_and(|fs| (fs & (1 << 5)) != 0)
            || self.table(b"head").and_then(|t| u16_be(t, 44)).is_some_and(|ms| (ms & 1) != 0)
    }

    fn is_italic(&self) -> bool {
        self.table(b"OS/2").and_then(|t| u16_be(t, 62)).is_some_and(|fs| (fs & ((1 << 0) | (1 << 9))) != 0)
            || self.table(b"head").and_then(|t| u16_be(t, 44)).is_some_and(|ms| (ms & 2) != 0)
    }

    fn is_monospaced(&self) -> bool {
        self.table(b"post").and_then(|t| u32_be(t, 12)).unwrap_or(0) != 0
    }

    fn italic_angle(&self) -> f64 {
        self.table(b"post").and_then(|t| i32_be(t, 4)).unwrap_or(0) as f64 / 65536.0
    }

    fn bbox(&self) -> (i16, i16, i16, i16) {
        let Some(h) = self.table(b"head") else { return (0, 0, 0, 0) };
        (i16_be(h, 36).unwrap_or(0), i16_be(h, 38).unwrap_or(0), i16_be(h, 40).unwrap_or(0), i16_be(h, 42).unwrap_or(0))
    }

    fn ascender(&self) -> i16 {
        if let Some(os2) = self.table(b"OS/2") {
            if u16_be(os2, 62).is_some_and(|fs| (fs & 0x0080) != 0) {
                if let Some(a) = i16_be(os2, 68) {
                    return a;
                }
            }
        }
        self.table(b"hhea").and_then(|t| i16_be(t, 4)).unwrap_or(0)
    }

    fn descender(&self) -> i16 {
        if let Some(os2) = self.table(b"OS/2") {
            if u16_be(os2, 62).is_some_and(|fs| (fs & 0x0080) != 0) {
                if let Some(d) = i16_be(os2, 70) {
                    return d;
                }
            }
        }
        self.table(b"hhea").and_then(|t| i16_be(t, 6)).unwrap_or(0)
    }

    fn capital_height(&self) -> Option<i16> {
        let os2 = self.table(b"OS/2")?;
        (u16_be(os2, 0)? >= 2).then(|| i16_be(os2, 88)).flatten()
    }

    fn glyph_hor_advance(&self, gid: u16) -> Option<u16> {
        let num_glyphs = u16_be(self.table(b"maxp")?, 4)?;
        if gid >= num_glyphs {
            return None;
        }
        let num_hm = u16_be(self.table(b"hhea")?, 34)? as usize;
        if num_hm == 0 {
            return None;
        }
        let hmtx = self.table(b"hmtx")?;
        u16_be(hmtx, (gid as usize).min(num_hm - 1) * 4)
    }

    fn glyph_index(&self, ch: char) -> Option<u16> {
        let cmap = self.table(b"cmap")?;
        let count = u16_be(cmap, 2)? as usize;
        let code = ch as u32;
        for want_fmt in [12u16, 4u16] {
            for i in 0..count {
                let rec = 4 + i * 8;
                let (platform, encoding, off) = (u16_be(cmap, rec)?, u16_be(cmap, rec + 2)?, u32_be(cmap, rec + 4)?);
                if !(platform == 0 || (platform == 3 && matches!(encoding, 0 | 1 | 10))) {
                    continue;
                }
                let Some(sub) = cmap.get(off as usize..) else { continue };
                if u16_be(sub, 0) != Some(want_fmt) {
                    continue;
                }
                let gid = if want_fmt == 12 { cmap_fmt12(sub, code) } else { cmap_fmt4(sub, code) };
                if let Some(g) = gid.filter(|&g| g != 0) {
                    return Some(g);
                }
            }
        }
        None
    }
}

fn cmap_fmt12(sub: &[u8], code: u32) -> Option<u16> {
    let groups = u32_be(sub, 12)? as usize;
    let mut lo = 0usize;
    let mut hi = groups;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let p = 16usize.checked_add(mid.checked_mul(12)?)?;
        let (start, end, gid) = (u32_be(sub, p)?, u32_be(sub, p + 4)?, u32_be(sub, p + 8)?);
        if code < start {
            hi = mid;
        } else if code > end {
            lo = mid + 1;
        } else {
            return u16::try_from(gid.checked_add(code - start)?).ok();
        }
    }
    None
}

fn cmap_fmt4(sub: &[u8], code: u32) -> Option<u16> {
    let c = u16::try_from(code).ok()?;
    let seg_x2 = u16_be(sub, 6)? as usize;
    if !seg_x2.is_multiple_of(2) {
        return None;
    }
    let segs = seg_x2 / 2;
    let end_codes = 14usize;
    let start_codes = end_codes.checked_add(seg_x2)?.checked_add(2)?;
    let id_deltas = start_codes.checked_add(seg_x2)?;
    let id_range_offs = id_deltas.checked_add(seg_x2)?;
    for i in 0..segs {
        let end = u16_be(sub, end_codes + i * 2)?;
        if c > end {
            continue;
        }
        let start = u16_be(sub, start_codes + i * 2)?;
        if c < start {
            return None;
        }
        let delta = i16_be(sub, id_deltas + i * 2)? as i32;
        let ro_pos = id_range_offs + i * 2;
        let ro = u16_be(sub, ro_pos)? as usize;
        if ro == 0 {
            return Some((c as i32 + delta) as u16);
        }
        let g_off = ro_pos.checked_add(ro)?.checked_add(((c - start) as usize) * 2)?;
        let raw = u16_be(sub, g_off)?;
        return (raw != 0).then(|| (raw as i32 + delta) as u16);
    }
    None
}

#[derive(Clone, Debug)]
struct FaceRef {
    path: PathBuf,
    index: u32,
    bold: bool,
    italic: bool,
    plain_style: bool,
}

fn index() -> &'static HashMap<String, Vec<FaceRef>> {
    static INDEX: OnceLock<HashMap<String, Vec<FaceRef>>> = OnceLock::new();
    INDEX.get_or_init(|| build_index(&font_dirs()))
}

fn font_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    if cfg!(target_os = "windows") {
        let win = std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
        dirs.push(win.join("Fonts"));
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("Microsoft").join("Windows").join("Fonts"));
        }
    } else if cfg!(target_os = "macos") {
        dirs.push("/System/Library/Fonts".into());
        dirs.push("/Library/Fonts".into());
        if let Some(h) = &home {
            dirs.push(h.join("Library/Fonts"));
        }
    } else {
        dirs.push("/usr/share/fonts".into());
        dirs.push("/usr/local/share/fonts".into());
        if let Some(h) = &home {
            dirs.push(h.join(".local/share/fonts"));
            dirs.push(h.join(".fonts"));
        }
    }
    dirs
}

fn squash(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect()
}

fn worth_reading(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if !matches!(ext.as_deref(), Some("ttf" | "otf" | "ttc" | "otc")) {
        return false;
    }
    let stem = squash(path.file_stem().and_then(|s| s.to_str()).unwrap_or_default());
    FAMILIES.iter().any(|f| stem.starts_with(&squash(f)[..4])) || FILE_ALIASES.iter().any(|a| stem.starts_with(a))
}

fn collect_files(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth > 0 {
                collect_files(&p, depth - 1, out);
            }
        } else if worth_reading(&p) {
            out.push(p);
        }
    }
}

fn build_index(dirs: &[PathBuf]) -> HashMap<String, Vec<FaceRef>> {
    let wanted: HashMap<String, &str> = FAMILIES.iter().map(|f| (f.to_ascii_lowercase(), *f)).collect();
    let mut files = Vec::new();
    for d in dirs {
        collect_files(d, 4, &mut files);
    }
    let mut out: HashMap<String, Vec<FaceRef>> = HashMap::new();
    for path in files {
        let Ok(data) = std::fs::read(&path) else { continue };
        let count = fonts_in_collection(&data).unwrap_or(1);
        for index in 0..count.min(64) {
            let Some(face) = Face::parse(&data, index) else { continue };
            let mut families = face.names(NAME_TYPO_FAMILY);
            families.extend(face.names(NAME_FAMILY));
            // A face can belong to two listed families ("Calibri Light" is also "Calibri").
            let mut matched: Vec<String> =
                families.iter().map(|f| f.to_ascii_lowercase()).filter(|f| wanted.contains_key(f)).collect();
            matched.dedup();
            if matched.is_empty() {
                continue;
            }
            let styles: Vec<String> =
                face.names(NAME_TYPO_SUBFAMILY).into_iter().chain(face.names(NAME_SUBFAMILY)).collect();
            let plain_style =
                styles.iter().any(|s| matches!(s.as_str(), "Regular" | "Bold" | "Italic" | "Bold Italic"));
            for family in matched {
                let faces = out.entry(family).or_default();
                if faces.iter().any(|f| f.path == path && f.index == index) {
                    continue;
                }
                faces.push(FaceRef {
                    path: path.clone(),
                    index,
                    bold: face.is_bold(),
                    italic: face.is_italic(),
                    plain_style,
                });
            }
        }
    }
    out
}

pub fn installed() -> Vec<String> {
    let idx = index();
    FAMILIES.iter().filter(|f| idx.contains_key(&f.to_ascii_lowercase())).map(|f| f.to_string()).collect()
}

#[derive(Clone)]
pub struct FontData {
    pub data: Arc<Vec<u8>>,
    pub index: u32,
}

pub fn find(family: &str, bold: bool, italic: bool) -> Option<FontData> {
    let faces = index().get(&family.to_ascii_lowercase())?;
    let score = |f: &FaceRef| (f.bold == bold) as u8 * 4 + (f.italic == italic) as u8 * 2 + f.plain_style as u8;
    let best = faces.iter().max_by_key(|f| score(f))?;
    load(&best.path, best.index)
}

fn load(path: &Path, index: u32) -> Option<FontData> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<Vec<u8>>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut c = cache.lock().ok()?;
    if let Some(d) = c.get(path) {
        return Some(FontData { data: d.clone(), index });
    }
    let d = Arc::new(std::fs::read(path).ok()?);
    c.insert(path.to_path_buf(), d.clone());
    Some(FontData { data: d, index })
}

pub struct EmbeddedFont {
    font: FontData,
    remapper: GlyphRemapper,
    glyphs: BTreeMap<u16, (f64, String)>,
    by_char: HashMap<char, u16>,
}

impl EmbeddedFont {
    pub fn new(font: FontData, text: &str) -> Option<Self> {
        let face = Face::parse(&font.data, font.index)?;
        let upem = face.upem as f64;
        let mut e = EmbeddedFont {
            font: font.clone(),
            remapper: GlyphRemapper::new(),
            glyphs: BTreeMap::new(),
            by_char: HashMap::new(),
        };
        let notdef_w = face.glyph_hor_advance(0).unwrap_or(0) as f64 * 1000.0 / upem;
        e.glyphs.insert(0, (notdef_w, String::new()));
        for ch in text.chars() {
            if ch == '\n' || e.by_char.contains_key(&ch) {
                continue;
            }
            let old = face.glyph_index(ch).unwrap_or(0);
            let new = e.remapper.remap(old);
            let w = face.glyph_hor_advance(old).unwrap_or(0) as f64 * 1000.0 / upem;
            e.glyphs.entry(new).or_insert_with(|| (w, ch.to_string()));
            e.by_char.insert(ch, new);
        }
        Some(e)
    }

    fn gid(&self, ch: char) -> u16 {
        self.by_char.get(&ch).copied().unwrap_or(0)
    }

    pub fn width(&self, s: &str, size: f64) -> f64 {
        s.chars().map(|c| self.glyphs.get(&self.gid(c)).map_or(0.0, |g| g.0)).sum::<f64>() * size / 1000.0
    }

    pub fn show(&self, s: &str) -> String {
        let mut out = String::from("<");
        for c in s.chars() {
            out.push_str(&format!("{:04X}", self.gid(c)));
        }
        out.push('>');
        out
    }

    pub fn write(&self, doc: &mut Document) -> Result<ObjectId, String> {
        let face = Face::parse(&self.font.data, self.font.index).ok_or_else(|| "invalid font".to_string())?;
        let subset = subsetter::subset(&self.font.data, self.font.index, &self.remapper).map_err(|e| e.to_string())?;
        let cff = face.has_cff();
        let upem = face.upem as f64;
        let k = |v: f64| (v * 1000.0 / upem).round() as i64;

        let ps = face.names(NAME_POST_SCRIPT).into_iter().next().unwrap_or_else(|| "Font".into());
        let ps: String = ps.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        let base = format!("{}+{}", subset_tag(&self.by_char), ps);

        let file = if cff {
            Stream::new(dictionary! { "Subtype" => "OpenType" }, subset)
        } else {
            let len = subset.len() as i64;
            Stream::new(dictionary! { "Length1" => len }, subset)
        };
        let mut file = file;
        let _ = file.compress();
        let file_id = doc.add_object(file);

        let (x_min, y_min, x_max, y_max) = face.bbox();
        let mut flags = 32;
        if face.is_monospaced() {
            flags |= 1;
        }
        if face.is_italic() {
            flags |= 64;
        }
        let descriptor = dictionary! {
            "Type" => "FontDescriptor",
            "FontName" => Object::Name(base.clone().into_bytes()),
            "Flags" => flags,
            "FontBBox" => vec![k(x_min as f64).into(), k(y_min as f64).into(), k(x_max as f64).into(), k(y_max as f64).into()],
            "ItalicAngle" => face.italic_angle(),
            "Ascent" => k(face.ascender() as f64),
            "Descent" => k(face.descender() as f64),
            "CapHeight" => k(face.capital_height().unwrap_or_else(|| face.ascender()) as f64),
            "StemV" => if face.is_bold() { 140 } else { 80 },
            if cff { "FontFile3" } else { "FontFile2" } => file_id,
        };
        let descriptor_id = doc.add_object(descriptor);

        let widths: Vec<Object> = (0..self.remapper.num_gids())
            .map(|g| Object::Integer(self.glyphs.get(&g).map_or(0.0, |w| w.0).round() as i64))
            .collect();
        let mut cid = dictionary! {
            "Type" => "Font",
            "Subtype" => if cff { "CIDFontType0" } else { "CIDFontType2" },
            "BaseFont" => Object::Name(base.clone().into_bytes()),
            "CIDSystemInfo" => dictionary! {
                "Registry" => Object::string_literal("Adobe"),
                "Ordering" => Object::string_literal("Identity"),
                "Supplement" => 0,
            },
            "FontDescriptor" => descriptor_id,
            "W" => vec![Object::Integer(0), Object::Array(widths)],
        };
        if !cff {
            cid.set("CIDToGIDMap", "Identity");
        }
        let cid_id = doc.add_object(cid);

        let mut cmap = Stream::new(dictionary! {}, self.to_unicode().into_bytes());
        let _ = cmap.compress();
        let cmap_id = doc.add_object(cmap);

        Ok(doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type0",
            "BaseFont" => Object::Name(base.into_bytes()),
            "Encoding" => "Identity-H",
            "DescendantFonts" => vec![Object::Reference(cid_id)],
            "ToUnicode" => cmap_id,
        }))
    }

    fn to_unicode(&self) -> String {
        let mut s = String::from(
            "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n\
             /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
             /CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n\
             1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
        );
        let entries: Vec<(u16, &str)> =
            self.glyphs.iter().filter(|(_, g)| !g.1.is_empty()).map(|(id, g)| (*id, g.1.as_str())).collect();
        for chunk in entries.chunks(100) {
            s.push_str(&format!("{} beginbfchar\n", chunk.len()));
            for (id, text) in chunk {
                let hex: String = text.encode_utf16().map(|u| format!("{u:04X}")).collect();
                s.push_str(&format!("<{id:04X}> <{hex}>\n"));
            }
            s.push_str("endbfchar\n");
        }
        s.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
        s
    }
}

fn subset_tag(chars: &HashMap<char, u16>) -> String {
    let mut sorted: Vec<char> = chars.keys().copied().collect();
    sorted.sort_unstable();
    let mut h: u32 = 2166136261;
    for c in sorted {
        h = (h ^ c as u32).wrapping_mul(16777619);
    }
    (0..6).map(|i| (b'A' + ((h >> (i * 5)) % 26) as u8) as char).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn some_ttf() -> Option<FontData> {
        let mut files = Vec::new();
        for d in ["/usr/share/fonts", "/Library/Fonts", "/System/Library/Fonts", "C:\\Windows\\Fonts"] {
            collect_any(Path::new(d), 4, &mut files);
        }
        files.sort();
        let p = files
            .into_iter()
            .find(|p| std::fs::read(p).ok().and_then(|d| Face::parse(&d, 0).map(|f| f.has_glyf())).unwrap_or(false))?;
        Some(FontData { data: Arc::new(std::fs::read(p).ok()?), index: 0 })
    }

    fn collect_any(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                if depth > 0 {
                    collect_any(&p, depth - 1, out);
                }
            } else if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("ttf")) {
                out.push(p);
            }
        }
    }

    #[test]
    fn file_names_are_filtered_before_reading() {
        assert!(worth_reading(Path::new("C:/Windows/Fonts/arialbd.ttf")));
        assert!(worth_reading(Path::new("/System/Library/Fonts/Supplemental/Trebuchet MS Bold.ttf")));
        assert!(worth_reading(Path::new("/System/Library/Fonts/HelveticaNeue.ttc")));
        assert!(worth_reading(Path::new("C:/Windows/Fonts/framd.ttf")));
        assert!(!worth_reading(Path::new("/usr/share/fonts/noto/NotoSans-Regular.ttf")));
        assert!(!worth_reading(Path::new("C:/Windows/Fonts/arial.fon")));
    }

    #[test]
    fn an_unknown_family_is_not_found() {
        assert!(find("No Such Font", false, false).is_none());
    }

    #[test]
    fn text_is_shown_with_subset_glyph_ids_and_measured() {
        let Some(font) = some_ttf() else { return };
        let e = EmbeddedFont::new(font, "abca").unwrap();
        assert_eq!(e.show("abca"), "<0001000200030001>");
        assert!(e.width("ab", 10.0) > 0.0);
        assert!((e.width("abab", 10.0) - 2.0 * e.width("ab", 10.0)).abs() < 1e-9);
    }

    #[test]
    fn the_font_is_written_as_a_type0_font_with_its_subset() {
        let Some(font) = some_ttf() else { return };
        let e = EmbeddedFont::new(font, "Été").unwrap();
        let mut doc = Document::with_version("1.7");
        let id = e.write(&mut doc).unwrap();
        let f = doc.get_dictionary(id).unwrap();
        assert_eq!(f.get(b"Subtype").unwrap().as_name().unwrap(), b"Type0");
        assert_eq!(f.get(b"Encoding").unwrap().as_name().unwrap(), b"Identity-H");
        let cmap = e.to_unicode();
        assert!(cmap.contains("<00C9>"), "{cmap}");
    }
}
