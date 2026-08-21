use super::*;
use yaml_rust2::parser::{Event, EventReceiver, Parser};
use yaml_rust2::scanner::TScalarStyle;

#[derive(Debug, Clone, PartialEq)]
pub struct SkillMetadata {
    pub name: String,
    pub declared_name: String,
    pub display_name: Option<String>,
    pub description: String,
    pub source: String,
    pub path: String,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub priority: String,
    pub triggers: Vec<String>,
    pub version: Option<String>,
    pub author: Option<String>,
    pub created_by_email: Option<String>,
    pub references: Vec<String>,
    pub scripts: Vec<String>,
    pub required_mcp_servers: Vec<String>,
    pub content: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SkillResourceMetadata {
    pub relative_path: String,
    pub kind: String,
    pub mime_type: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillResourcePathError {
    Missing,
    Invalid,
}

impl std::fmt::Display for SkillResourcePathError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing => formatter.write_str("skill resource does not exist"),
            Self::Invalid => formatter.write_str("skill resource path is not allowed"),
        }
    }
}

impl std::error::Error for SkillResourcePathError {}

fn skill_name_leaf(name: &str) -> &str {
    name.rsplit('/').next().unwrap_or(name)
}

/// Mirror of the Electron formatter (skill-frontmatter.js
/// formatSkillDisplayName): runs of -_/ collapse to one space, each word's
/// first char is uppercased (rest preserved), and Titlecased acronym words
/// are fully uppercased. Skill ids are ASCII kebab; keep both sides in
/// lockstep via the mirrored example tables in each side's tests.
pub fn format_skill_display_name(value: &str) -> String {
    const DISPLAY_ACRONYMS: [&str; 10] = [
        "Lm", "Mcp", "Api", "Url", "Ui", "Ai", "Id", "Gtm", "Qa", "Icp",
    ];
    value
        .split(['-', '_', '/', ' ', '\t', '\n', '\r'])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            let capitalized = match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            };
            if DISPLAY_ACRONYMS.contains(&capitalized.as_str()) {
                capitalized.to_uppercase()
            } else {
                capitalized
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

impl SkillMetadata {
    /// Human-facing title, never empty. An explicitly authored display_name
    /// wins unless it merely restates the kebab id — installed-copy sidecars
    /// are written with display_name = the solution's kebab name, and
    /// treating those as authored titles would defeat derivation for every
    /// marketplace install.
    pub fn effective_display_name(&self) -> String {
        let name_leaf = skill_name_leaf(&self.name);
        if let Some(explicit) = self.display_name.as_deref() {
            let explicit = explicit.trim();
            if !explicit.is_empty()
                && explicit != self.name
                && explicit != self.declared_name
                && explicit != name_leaf
            {
                return explicit.to_string();
            }
        }
        let declared = self.declared_name.trim();
        let base = if declared.is_empty() { name_leaf } else { declared };
        format_skill_display_name(base)
    }

    pub fn to_json(&self, include_content: bool) -> Value {
        let mut result = json!({
            "name": self.name,
            "declared_name": self.declared_name,
            "display_name": self.effective_display_name(),
            "description": self.description,
            "source": self.source,
            "path": self.path,
            "license": self.license,
            "compatibility": self.compatibility,
            "priority": self.priority,
            "triggers": self.triggers,
            "version": self.version,
            "author": self.author,
            "created_by_email": self.created_by_email,
            "references": self.references,
            "scripts": self.scripts,
            "required_mcp_servers": self.required_mcp_servers,
        });

        if include_content {
            if let Some(object) = result.as_object_mut() {
                object.insert(
                    "content".to_string(),
                    self.content
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                );
            }
        }

        result
    }
}

pub fn discover_skills() -> Result<Vec<SkillMetadata>> {
    let base_dir = app_root()?;
    let directories = [
        ("skills", "system"),
        ("skills-user", "user"),
        ("skills-marketplace", "marketplace"),
    ];

    let mut discovered = Vec::new();
    let mut seen = HashSet::new();

    for (dir_name, source_type) in directories {
        let skills_root = base_dir.join(dir_name);
        if !skills_root.exists() {
            continue;
        }

        let mut skill_files = WalkDir::new(&skills_root)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file() && entry.file_name() == "SKILL.md")
            .map(|entry| entry.path().to_path_buf())
            .collect::<Vec<_>>();
        skill_files.sort();

        for skill_md in skill_files {
            let Some(skill_name) = derive_skill_name(&skills_root, &skill_md, source_type) else {
                continue;
            };
            if seen.contains(&skill_name) {
                continue;
            }

            let metadata = match parse_skill_file(&skill_md, source_type, &skill_name) {
                Ok(Some(metadata)) => metadata,
                Ok(None) => continue,
                Err(error) => {
                    warn!("failed to parse skill {}: {error:#}", skill_md.display());
                    continue;
                }
            };

            seen.insert(skill_name);
            discovered.push(metadata);
        }
    }

    Ok(discovered)
}

pub fn validate_skill_path(skill_name: &str, subpath: Option<&str>) -> Result<PathBuf> {
    let skills_user = skills_user_dir()?;
    let safe_skill_name = safe_path_component(skill_name);
    if safe_skill_name.is_empty() {
        bail!("Invalid skill name");
    }
    let mut full_path = skills_user.join(safe_skill_name);
    if let Some(subpath) = subpath {
        let subpath = Path::new(subpath);
        if subpath.is_absolute()
            || subpath
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            bail!("Invalid path");
        }
        full_path = full_path.join(subpath);
    }
    Ok(full_path)
}

pub fn find_skill(skill_name: &str) -> Result<Option<SkillMetadata>> {
    let skills = discover_skills()?;
    if let Some(skill) = skills.iter().find(|skill| skill.name == skill_name) {
        return Ok(Some(skill.clone()));
    }

    // Legacy 2-segment marketplace ids ({mp}/{leaf}) written before the
    // plugin layout resolve when exactly ONE plugin-installed skill matches
    // {mp}/*/{leaf}. Ambiguity resolves to None rather than guessing.
    let parts: Vec<&str> = skill_name.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() == 2 {
        let mut matches = skills.iter().filter(|skill| {
            let candidate: Vec<&str> = skill.name.split('/').collect();
            candidate.len() == 3 && candidate[0] == parts[0] && candidate[2] == parts[1]
        });
        let first = matches.next().cloned();
        if matches.next().is_none() {
            return Ok(first);
        }
        warn!("skill id {skill_name} is ambiguous across plugins; refusing to guess");
        return Ok(None);
    }

    Ok(None)
}

pub fn read_skill_markdown(skill: &SkillMetadata) -> Result<String> {
    let skill_dir = PathBuf::from(&skill.path);
    fs::read_to_string(skill_dir.join("SKILL.md"))
        .with_context(|| format!("failed to read {}", skill_dir.join("SKILL.md").display()))
}

pub fn list_skill_resources(skill: &SkillMetadata) -> Result<Vec<SkillResourceMetadata>> {
    let skill_dir = PathBuf::from(&skill.path);
    let mut resources = Vec::new();
    let entries = WalkDir::new(&skill_dir)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || (!resource_component_is_ignored(entry.file_name())
                    && !resource_path_has_generated_extension(entry.path()))
        });

    for entry in entries {
        let entry = entry
            .with_context(|| format!("failed to enumerate resources for skill '{}'", skill.name))?;
        if entry.depth() == 0 || !entry.file_type().is_file() {
            continue;
        }
        let Some(relative_path) = path_to_unix_string(&skill_dir, entry.path()) else {
            continue;
        };
        if resource_path_is_skill_markdown(&relative_path) {
            continue;
        }
        resources.push(skill_resource_metadata(&relative_path, entry.path())?);
    }

    resources.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(resources)
}

pub fn resolve_skill_resource_path(
    skill: &SkillMetadata,
    resource_path: &str,
) -> std::result::Result<PathBuf, SkillResourcePathError> {
    let relative_path = Path::new(resource_path);
    if resource_path.trim().is_empty()
        || resource_path.contains('\\')
        || relative_path.is_absolute()
        || resource_path_is_skill_markdown(resource_path)
    {
        return Err(SkillResourcePathError::Invalid);
    }

    for component in relative_path.components() {
        match component {
            std::path::Component::Normal(value) if !resource_component_is_ignored(value) => {}
            _ => return Err(SkillResourcePathError::Invalid),
        }
    }
    if resource_path_has_generated_extension(relative_path) {
        return Err(SkillResourcePathError::Invalid);
    }

    let skill_dir = PathBuf::from(&skill.path);
    let candidate = skill_dir.join(relative_path);
    if !candidate.exists() {
        return Err(SkillResourcePathError::Missing);
    }

    let skill_root = fs::canonicalize(&skill_dir).map_err(|_| SkillResourcePathError::Invalid)?;
    let resolved = fs::canonicalize(&candidate).map_err(|_| SkillResourcePathError::Invalid)?;
    if !resolved.starts_with(&skill_root) {
        return Err(SkillResourcePathError::Invalid);
    }
    let metadata = fs::metadata(&resolved).map_err(|_| SkillResourcePathError::Invalid)?;
    if !metadata.is_file() {
        return Err(SkillResourcePathError::Invalid);
    }

    Ok(resolved)
}

pub fn skill_resource_metadata(
    relative_path: &str,
    resolved_path: &Path,
) -> Result<SkillResourceMetadata> {
    let metadata = fs::metadata(resolved_path)
        .with_context(|| format!("failed to inspect skill resource '{relative_path}'"))?;
    if !metadata.is_file() {
        bail!("skill resource is not a regular file");
    }
    let first_component = Path::new(relative_path)
        .components()
        .find_map(|component| match component {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .unwrap_or_default();
    let kind = match first_component {
        "references" => "reference",
        "scripts" => "script",
        "assets" => "asset",
        _ => "other",
    };
    let mime_type = MimeGuess::from_path(relative_path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();

    Ok(SkillResourceMetadata {
        relative_path: relative_path.to_string(),
        kind: kind.to_string(),
        mime_type,
        size_bytes: metadata.len(),
    })
}

fn resource_path_is_skill_markdown(resource_path: &str) -> bool {
    Path::new(resource_path)
        .file_name()
        .and_then(|value| value.to_str())
        == Some("SKILL.md")
}

fn resource_component_is_ignored(component: &std::ffi::OsStr) -> bool {
    let component = component.to_string_lossy();
    component.starts_with('.') || component == "__pycache__"
}

fn resource_path_has_generated_extension(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("pyc" | "pyo")
    )
}

pub fn derive_skill_name(skills_root: &Path, skill_md: &Path, source_type: &str) -> Option<String> {
    let relative = skill_md.strip_prefix(skills_root).ok()?;
    let parts = relative.components().collect::<Vec<_>>();
    if parts.iter().any(|part| {
        let part = part.as_os_str().to_string_lossy();
        part.starts_with('.') || part.starts_with('_')
    }) {
        return None;
    }

    match source_type {
        // Flat layout: {mp}/{skill}/SKILL.md
        "marketplace" if parts.len() == 3 => Some(format!(
            "{}/{}",
            parts[0].as_os_str().to_string_lossy(),
            parts[1].as_os_str().to_string_lossy()
        )),
        // Plugin layout: {mp}/{plugin}/{skill}/SKILL.md — but never past a
        // SKILL.md directory: when {mp}/{plugin} is itself a skill, this
        // deeper SKILL.md is that skill's reference material, not a skill
        // (parent-guard, not just depth counting).
        "marketplace" if parts.len() == 4 => {
            let parent_skill_md = skills_root
                .join(parts[0].as_os_str())
                .join(parts[1].as_os_str())
                .join("SKILL.md");
            if parent_skill_md.is_file() {
                return None;
            }
            Some(format!(
                "{}/{}/{}",
                parts[0].as_os_str().to_string_lossy(),
                parts[1].as_os_str().to_string_lossy(),
                parts[2].as_os_str().to_string_lossy()
            ))
        }
        "system" | "user" if parts.len() == 2 => {
            Some(parts[0].as_os_str().to_string_lossy().to_string())
        }
        _ => None,
    }
}

pub fn split_frontmatter(raw: &str) -> (Option<String>, String) {
    let mut lines = raw.lines();
    match lines.next() {
        Some(first) if first.trim() == "---" => {}
        _ => return (None, raw.trim().to_string()),
    }

    let mut frontmatter_lines = Vec::new();
    let mut body_lines = Vec::new();
    let mut in_frontmatter = true;

    for line in lines {
        if in_frontmatter && line.trim() == "---" {
            in_frontmatter = false;
            continue;
        }

        if in_frontmatter {
            frontmatter_lines.push(line);
        } else {
            body_lines.push(line);
        }
    }

    let frontmatter = if in_frontmatter {
        None
    } else {
        Some(frontmatter_lines.join("\n"))
    };

    (frontmatter, body_lines.join("\n").trim().to_string())
}

#[derive(Default)]
struct SkillFrontmatterEventReceiver {
    events: Vec<Event>,
}

impl EventReceiver for SkillFrontmatterEventReceiver {
    fn on_event(&mut self, event: Event) {
        if !matches!(event, Event::Nothing) {
            self.events.push(event);
        }
    }
}

fn parse_skill_frontmatter(frontmatter: &str) -> Result<Value> {
    let mut parser = Parser::new_from_str(frontmatter);
    let mut receiver = SkillFrontmatterEventReceiver::default();
    parser
        .load(&mut receiver, true)
        .context("failed to parse skill frontmatter")?;

    let mut events = receiver.events.into_iter().peekable();

    match events.next() {
        Some(Event::StreamStart) => {}
        other => bail!("expected YAML stream start, found {other:?}"),
    }
    match events.next() {
        Some(Event::DocumentStart) => {}
        other => bail!("expected YAML document start, found {other:?}"),
    }

    let parsed = parse_skill_frontmatter_value(&mut events)?;

    match events.next() {
        Some(Event::DocumentEnd) => {}
        other => bail!("expected YAML document end, found {other:?}"),
    }
    match events.next() {
        Some(Event::StreamEnd) => {}
        other => bail!("expected YAML stream end, found {other:?}"),
    }

    Ok(parsed)
}

fn parse_skill_frontmatter_value<I>(events: &mut std::iter::Peekable<I>) -> Result<Value>
where
    I: Iterator<Item = Event>,
{
    match events.next() {
        Some(Event::Scalar(value, style, ..)) => Ok(parse_skill_frontmatter_scalar(value, style)),
        Some(Event::SequenceStart(..)) => parse_skill_frontmatter_sequence(events),
        Some(Event::MappingStart(..)) => parse_skill_frontmatter_mapping(events),
        Some(Event::Alias(_)) => bail!("YAML aliases are not supported in skill frontmatter"),
        Some(other) => bail!("unexpected YAML event in skill frontmatter: {other:?}"),
        None => bail!("unexpected end of YAML stream while parsing skill frontmatter"),
    }
}

fn parse_skill_frontmatter_scalar(value: String, style: TScalarStyle) -> Value {
    if style != TScalarStyle::Plain {
        return Value::String(value);
    }

    match value.to_ascii_lowercase().as_str() {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        "null" | "~" => return Value::Null,
        _ => {}
    }

    if let Ok(number) = value.parse::<i64>() {
        return Value::Number(number.into());
    }
    if let Ok(number) = value.parse::<u64>() {
        return Value::Number(number.into());
    }
    if let Ok(number) = value.parse::<f64>() {
        if let Some(number) = serde_json::Number::from_f64(number) {
            return Value::Number(number);
        }
    }

    Value::String(value)
}

fn parse_skill_frontmatter_sequence<I>(events: &mut std::iter::Peekable<I>) -> Result<Value>
where
    I: Iterator<Item = Event>,
{
    let mut items = Vec::new();

    loop {
        match events.peek() {
            Some(Event::SequenceEnd) => {
                events.next();
                break;
            }
            Some(_) => items.push(parse_skill_frontmatter_value(events)?),
            None => bail!("unterminated YAML sequence in skill frontmatter"),
        }
    }

    Ok(Value::Array(items))
}

fn parse_skill_frontmatter_mapping<I>(events: &mut std::iter::Peekable<I>) -> Result<Value>
where
    I: Iterator<Item = Event>,
{
    let mut object = Map::new();

    loop {
        match events.peek() {
            Some(Event::MappingEnd) => {
                events.next();
                break;
            }
            Some(_) => {
                let key = match events.next() {
                    Some(Event::Scalar(value, ..)) => value,
                    Some(other) => {
                        bail!("skill frontmatter keys must be scalars, found {other:?}")
                    }
                    None => bail!("unexpected end of YAML stream while reading skill key"),
                };
                let value = parse_skill_frontmatter_value(events)?;
                object.insert(key, value);
            }
            None => bail!("unterminated YAML mapping in skill frontmatter"),
        }
    }

    Ok(Value::Object(object))
}

fn frontmatter_object<'a>(value: &'a Value, key: &str) -> Option<&'a Map<String, Value>> {
    value.as_object()?.get(key)?.as_object()
}

fn frontmatter_string(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_string)
}

fn frontmatter_version_string(map: &Map<String, Value>, key: &str) -> Option<String> {
    match map.get(key) {
        Some(Value::String(value)) => Some(value.to_string()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn frontmatter_array_strings(map: &Map<String, Value>, key: &str) -> Vec<String> {
    match map.get(key) {
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        Some(Value::String(value)) => vec![value.to_string()],
        _ => Vec::new(),
    }
}

fn frontmatter_trigger_strings(map: &Map<String, Value>, key: &str) -> Vec<String> {
    let Some(value) = map.get(key) else {
        return Vec::new();
    };
    let entries: Vec<&Value> = match value {
        Value::Array(values) => values.iter().collect(),
        other => vec![other],
    };
    let mut triggers = Vec::new();
    let mut seen = HashSet::new();

    let mut add_trigger = |value: &Value| {
        let Some(raw) = value.as_str() else {
            return;
        };
        let trigger = raw.trim();
        if trigger.is_empty() {
            return;
        }
        let dedupe_key = trigger.to_lowercase();
        if seen.insert(dedupe_key) {
            triggers.push(trigger.to_string());
        }
    };

    for entry in entries {
        if entry.is_string() {
            add_trigger(entry);
            continue;
        }
        let Some(keywords) = entry.as_object().and_then(|item| item.get("keywords")) else {
            continue;
        };
        match keywords {
            Value::Array(values) => {
                for keyword in values {
                    add_trigger(keyword);
                }
            }
            other => add_trigger(other),
        }
    }

    triggers
}

fn sibling_skill_yaml_path(skill_md: &Path) -> Result<PathBuf> {
    let skill_dir = skill_md
        .parent()
        .context("skill file missing parent directory")?;
    let skill_dir_name = skill_dir
        .file_name()
        .and_then(|value| value.to_str())
        .context("skill directory missing file name")?;
    Ok(skill_dir.join(format!("{skill_dir_name}.yaml")))
}

fn sibling_skill_triggers(map: &Map<String, Value>) -> Vec<String> {
    let mut triggers = Vec::new();
    for key in ["topic", "domain"] {
        let Some(value) = frontmatter_string(map, key) else {
            continue;
        };
        if !triggers.contains(&value) {
            triggers.push(value);
        }
    }
    triggers
}

fn parse_sibling_skill_metadata(skill_md: &Path) -> Result<Option<Value>> {
    let sibling_yaml = sibling_skill_yaml_path(skill_md)?;
    if !sibling_yaml.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&sibling_yaml)
        .with_context(|| format!("failed to read sibling metadata {}", sibling_yaml.display()))?;
    let parsed = parse_skill_frontmatter(&raw).with_context(|| {
        format!(
            "failed to parse sibling metadata {}",
            sibling_yaml.display()
        )
    })?;
    let Some(map) = parsed.as_object() else {
        return Ok(None);
    };

    let Some(skill_name) = frontmatter_string(map, "skill_name") else {
        return Ok(None);
    };
    let Some(description) = frontmatter_string(map, "description") else {
        return Ok(None);
    };

    let mut metadata = Map::new();
    metadata.insert("name".to_string(), Value::String(skill_name));
    metadata.insert("description".to_string(), Value::String(description));
    metadata.insert("priority".to_string(), Value::String("medium".to_string()));
    metadata.insert("required_mcp_servers".to_string(), Value::Array(Vec::new()));

    if let Some(author) = frontmatter_string(map, "owner") {
        metadata.insert("author".to_string(), Value::String(author));
    }

    if let Some(display_name) = frontmatter_string(map, "display_name") {
        metadata.insert("display_name".to_string(), Value::String(display_name));
    }

    let triggers = sibling_skill_triggers(map)
        .into_iter()
        .map(Value::String)
        .collect::<Vec<_>>();
    metadata.insert("triggers".to_string(), Value::Array(triggers));

    Ok(Some(Value::Object(metadata)))
}

pub fn parse_skill_file(
    skill_md: &Path,
    source_type: &str,
    skill_name: &str,
) -> Result<Option<SkillMetadata>> {
    let raw = fs::read_to_string(skill_md)
        .with_context(|| format!("failed to read skill file {}", skill_md.display()))?;
    let (frontmatter, body) = split_frontmatter(&raw);
    let (parsed, content) = if let Some(frontmatter) = frontmatter {
        (
            parse_skill_frontmatter(&frontmatter)
                .with_context(|| format!("failed to parse frontmatter {}", skill_md.display()))?,
            body,
        )
    } else if let Some(parsed) = parse_sibling_skill_metadata(skill_md)? {
        (parsed, raw.clone())
    } else {
        return Ok(None);
    };
    let Some(map) = parsed.as_object() else {
        return Ok(None);
    };

    let metadata_block = frontmatter_object(&parsed, "metadata");
    let declared_name = frontmatter_string(map, "name");
    let display_name = frontmatter_string(map, "display_name")
        .or_else(|| metadata_block.and_then(|value| frontmatter_string(value, "display_name")));
    let description = frontmatter_string(map, "description");
    if declared_name.is_none() || description.is_none() {
        return Ok(None);
    }

    let skill_dir = skill_md
        .parent()
        .context("skill file missing parent directory")?;
    let references = collect_reference_files(skill_dir)?;
    let scripts = collect_relative_files(&skill_dir.join("scripts"), skill_dir, &["py"])?;

    let mut required_mcp_servers = metadata_block
        .map(|value| frontmatter_array_strings(value, "required_mcp_servers"))
        .unwrap_or_default();
    if required_mcp_servers.is_empty() {
        required_mcp_servers = frontmatter_array_strings(map, "required_mcp_servers");
    }

    let mut triggers = metadata_block
        .map(|value| frontmatter_trigger_strings(value, "triggers"))
        .unwrap_or_default();
    if triggers.is_empty() {
        triggers = frontmatter_trigger_strings(map, "triggers");
    }

    let mut skill = SkillMetadata {
        name: skill_name.to_string(),
        declared_name: declared_name.unwrap_or_default(),
        display_name,
        description: description.unwrap_or_default(),
        source: source_type.to_string(),
        path: skill_dir.to_string_lossy().to_string(),
        license: frontmatter_string(map, "license"),
        compatibility: frontmatter_string(map, "compatibility"),
        priority: metadata_block
            .and_then(|value| frontmatter_string(value, "priority"))
            .or_else(|| frontmatter_string(map, "priority"))
            .unwrap_or_else(|| "medium".to_string()),
        triggers,
        version: metadata_block
            .and_then(|value| frontmatter_version_string(value, "version"))
            .or_else(|| frontmatter_version_string(map, "version")),
        author: metadata_block
            .and_then(|value| frontmatter_string(value, "author"))
            .or_else(|| frontmatter_string(map, "author")),
        created_by_email: frontmatter_string(map, "created_by_email").or_else(|| {
            metadata_block.and_then(|value| frontmatter_string(value, "created_by_email"))
        }),
        references,
        scripts,
        required_mcp_servers,
        content: Some(content),
    };
    // Post-parse invariant: display_name is always Some. Every consumer of
    // the catalog (skills-server envelopes, the host bridge summaries)
    // inherits a non-null human title without its own fallback logic.
    skill.display_name = Some(skill.effective_display_name());
    Ok(Some(skill))
}

// Reference enumeration mirrors the read surface, by NAME only (no content
// reads — this runs on every list path): create_skill_reference accepts any
// extension and marketplace bundles ship both `references/` and the singular
// `reference/` layout, so neither an extension allowlist nor a single root is
// faithful. Entries resolve_skill_resource_path refuses to serve (dot or
// __pycache__ components, generated bytecode, nested SKILL.md) stay out so
// every advertised path is actually fetchable via get_skill_reference.
fn collect_reference_files(skill_dir: &Path) -> Result<Vec<String>> {
    let mut files = Vec::new();
    for dir_name in ["references", "reference"] {
        let root = skill_dir.join(dir_name);
        if !root.exists() {
            continue;
        }
        let entries = WalkDir::new(&root)
            .into_iter()
            .filter_entry(|entry| {
                entry.depth() == 0 || !resource_component_is_ignored(entry.file_name())
            })
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry.file_type().is_file()
                    && !resource_path_has_generated_extension(entry.path())
            })
            .filter_map(|entry| path_to_unix_string(skill_dir, entry.path()))
            .filter(|relative_path| !resource_path_is_skill_markdown(relative_path));
        files.extend(entries);
    }
    files.sort();
    Ok(files)
}

fn collect_relative_files(
    root: &Path,
    skill_dir: &Path,
    allowed_extensions: &[&str],
) -> Result<Vec<String>> {
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut files = WalkDir::new(root)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| allowed_extensions.contains(&value))
                .unwrap_or(false)
        })
        .filter_map(|entry| path_to_unix_string(skill_dir, entry.path()))
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TEST_ENV_LOCK;
    use std::sync::MutexGuard;

    fn sample_metadata() -> SkillMetadata {
        SkillMetadata {
            name: "example-skill".to_string(),
            declared_name: "example-skill".to_string(),
            display_name: Some("Example Skill".to_string()),
            description: "Example".to_string(),
            source: "system".to_string(),
            path: "/tmp/example-skill".to_string(),
            license: Some("MIT".to_string()),
            compatibility: Some("2026".to_string()),
            priority: "high".to_string(),
            triggers: vec!["example".to_string()],
            version: Some("1.0.0".to_string()),
            author: Some("Workbench".to_string()),
            created_by_email: Some("workbench@example.com".to_string()),
            references: vec!["references/guide.md".to_string()],
            scripts: vec!["scripts/run.py".to_string()],
            required_mcp_servers: vec!["time".to_string()],
            content: Some("# Example".to_string()),
        }
    }

    struct AppRootGuard {
        _guard: MutexGuard<'static, ()>,
        root: PathBuf,
        previous_cwd: PathBuf,
        previous_root: Option<String>,
    }

    impl AppRootGuard {
        fn new(name: &str) -> Self {
            let guard = TEST_ENV_LOCK
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            let root = env::temp_dir().join(format!(
                "core-mcp-rust-skills-catalog-{name}-{}",
                Uuid::new_v4().simple()
            ));
            fs::create_dir_all(root.join("mcp-configs")).expect("create mcp-configs dir");
            fs::create_dir_all(root.join("skills")).expect("create skills dir");
            fs::create_dir_all(root.join("skills-user")).expect("create skills-user dir");
            let previous_cwd = env::current_dir().expect("current dir");
            env::set_current_dir(&root).expect("set current dir");
            let previous_root = env::var("CONTAINER_PROJECT_ROOT").ok();
            env::set_var("CONTAINER_PROJECT_ROOT", &root);
            Self {
                _guard: guard,
                root,
                previous_cwd,
                previous_root,
            }
        }

        fn new_with_previous_root(name: &str, previous_root: &Path) -> Self {
            let guard = TEST_ENV_LOCK
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            let root = env::temp_dir().join(format!(
                "core-mcp-rust-skills-catalog-{name}-{}",
                Uuid::new_v4().simple()
            ));
            fs::create_dir_all(root.join("mcp-configs")).expect("create mcp-configs dir");
            fs::create_dir_all(root.join("skills")).expect("create skills dir");
            fs::create_dir_all(root.join("skills-user")).expect("create skills-user dir");
            let previous_cwd = env::current_dir().expect("current dir");
            env::set_current_dir(&root).expect("set current dir");
            env::set_var("CONTAINER_PROJECT_ROOT", previous_root);
            let previous_root = env::var("CONTAINER_PROJECT_ROOT").ok();
            env::set_var("CONTAINER_PROJECT_ROOT", &root);
            Self {
                _guard: guard,
                root,
                previous_cwd,
                previous_root,
            }
        }

        fn restore_env(&mut self) {
            let _ = env::set_current_dir(&self.previous_cwd);
            if let Some(value) = &self.previous_root {
                env::set_var("CONTAINER_PROJECT_ROOT", value);
            } else {
                env::remove_var("CONTAINER_PROJECT_ROOT");
            }
        }
    }

    impl Drop for AppRootGuard {
        fn drop(&mut self) {
            self.restore_env();
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn discover_skills_skips_missing_skill_directories() {
        let guard = AppRootGuard::new("missing-dirs");
        let skill_dir = guard.root.join("skills/example-skill");
        fs::create_dir_all(&skill_dir).expect("create example skill dir");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: example-skill\ndescription: Example\n---\n# Example\n",
        )
        .expect("write skill file");

        let discovered = discover_skills().expect("discover skills");
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].name, "example-skill");
    }

    #[test]
    fn format_skill_display_name_matches_electron_rules() {
        // Same example table as the Electron side's user-skill-service tests;
        // the two formatters (this fn and skill-frontmatter.js
        // formatSkillDisplayName) must stay in lockstep.
        assert_eq!(
            format_skill_display_name("epic-voice-booster"),
            "Epic Voice Booster"
        );
        assert_eq!(
            format_skill_display_name("mcp-lm-api-url-ui-ai-id"),
            "MCP LM API URL UI AI ID"
        );
        assert_eq!(
            format_skill_display_name("weekly_team_update"),
            "Weekly Team Update"
        );
        assert_eq!(
            format_skill_display_name("round9-mp/epic-skill"),
            "Round9 Mp Epic Skill"
        );
        assert_eq!(
            format_skill_display_name("  spaced   words "),
            "Spaced Words"
        );
        assert_eq!(format_skill_display_name(""), "");
        // "Api2" is not the whole-word acronym "Api"; "id" is.
        assert_eq!(format_skill_display_name("api2-id"), "Api2 ID");
        // 2026-08-03 incident additions: marketing slugs must not render as
        // "Gtm Brief Qa" on machines that lack the authored display_name.
        assert_eq!(format_skill_display_name("gtm-brief-qa"), "GTM Brief QA");
        assert_eq!(format_skill_display_name("gtm-icp-lookup"), "GTM ICP Lookup");
    }

    #[test]
    fn effective_display_name_prefers_authored_titles_and_derives_otherwise() {
        let mut skill = sample_metadata();
        assert_eq!(skill.effective_display_name(), "Example Skill");

        skill.display_name = None;
        assert_eq!(skill.effective_display_name(), "Example Skill");

        // A display_name that merely restates the kebab id (what installed-copy
        // sidecars contain) is treated as absent so derivation applies.
        skill.display_name = Some("example-skill".to_string());
        assert_eq!(skill.effective_display_name(), "Example Skill");

        // Marketplace ids derive from the leaf segment.
        skill.display_name = None;
        skill.declared_name = String::new();
        skill.name = "round9-mp/epic-voice-booster".to_string();
        assert_eq!(skill.effective_display_name(), "Epic Voice Booster");

        // ...even when the sidecar restates just the leaf.
        skill.display_name = Some("epic-voice-booster".to_string());
        assert_eq!(skill.effective_display_name(), "Epic Voice Booster");
    }

    #[test]
    fn to_json_always_emits_a_non_empty_display_name() {
        let mut skill = sample_metadata();
        skill.display_name = None;
        assert_eq!(skill.to_json(false)["display_name"], json!("Example Skill"));
    }

    #[test]
    fn parse_skill_file_derives_display_name_when_frontmatter_omits_it() {
        let guard = AppRootGuard::new("derived-display-name");
        let skill_dir = guard.root.join("skills/epic-voice-booster");
        fs::create_dir_all(&skill_dir).expect("create skill dir");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: epic-voice-booster\ndescription: Elevates text\n---\n# Epic\n",
        )
        .expect("write skill file");

        let parsed = parse_skill_file(
            &skill_dir.join("SKILL.md"),
            "system",
            "epic-voice-booster",
        )
        .expect("parse skill")
        .expect("skill metadata");
        assert_eq!(parsed.display_name.as_deref(), Some("Epic Voice Booster"));
    }

    #[test]
    fn sibling_yaml_display_name_survives_unless_it_restates_the_kebab_id() {
        let guard = AppRootGuard::new("sibling-display-name");

        let custom_dir = guard.root.join("skills/custom-title");
        fs::create_dir_all(&custom_dir).expect("create custom dir");
        fs::write(custom_dir.join("SKILL.md"), "# Raw body\n").expect("write skill");
        fs::write(
            custom_dir.join("custom-title.yaml"),
            "skill_name: \"custom-title\"\ndescription: \"Custom\"\ndisplay_name: \"A Handsome Title\"\n",
        )
        .expect("write sidecar");
        let parsed = parse_skill_file(&custom_dir.join("SKILL.md"), "system", "custom-title")
            .expect("parse custom")
            .expect("custom metadata");
        assert_eq!(parsed.display_name.as_deref(), Some("A Handsome Title"));

        // Installed-copy sidecars carry display_name = the kebab solution
        // name; that must fall back to the derived title.
        let kebab_dir = guard.root.join("skills/epic-voice-booster");
        fs::create_dir_all(&kebab_dir).expect("create kebab dir");
        fs::write(kebab_dir.join("SKILL.md"), "# Raw body\n").expect("write skill");
        fs::write(
            kebab_dir.join("epic-voice-booster.yaml"),
            "skill_name: \"epic-voice-booster\"\ndescription: \"Installed\"\ndisplay_name: \"epic-voice-booster\"\n",
        )
        .expect("write sidecar");
        let parsed =
            parse_skill_file(&kebab_dir.join("SKILL.md"), "system", "epic-voice-booster")
                .expect("parse kebab")
                .expect("kebab metadata");
        assert_eq!(parsed.display_name.as_deref(), Some("Epic Voice Booster"));

        // No sidecar display_name at all → derived from skill_name.
        let derived_dir = guard.root.join("skills/plain-install");
        fs::create_dir_all(&derived_dir).expect("create derived dir");
        fs::write(derived_dir.join("SKILL.md"), "# Raw body\n").expect("write skill");
        fs::write(
            derived_dir.join("plain-install.yaml"),
            "skill_name: \"plain-install\"\ndescription: \"Installed\"\n",
        )
        .expect("write sidecar");
        let parsed = parse_skill_file(&derived_dir.join("SKILL.md"), "system", "plain-install")
            .expect("parse derived")
            .expect("derived metadata");
        assert_eq!(parsed.display_name.as_deref(), Some("Plain Install"));
    }

    #[test]
    fn app_root_guard_restores_previous_container_root() {
        let previous_root = env::temp_dir().join(format!(
            "core-mcp-rust-skills-catalog-previous-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&previous_root).expect("create previous root");
        {
            let mut guard =
                AppRootGuard::new_with_previous_root("restore-previous", &previous_root);
            guard.restore_env();
            assert_eq!(
                env::var("CONTAINER_PROJECT_ROOT").ok().as_deref(),
                previous_root.to_str()
            );
        }
        env::remove_var("CONTAINER_PROJECT_ROOT");
        let _ = fs::remove_dir_all(&previous_root);
    }

    #[test]
    fn skill_metadata_to_json_handles_content_toggle() {
        let metadata = sample_metadata();
        let without_content = metadata.to_json(false);
        assert!(without_content.get("content").is_none());
        assert_eq!(without_content["declared_name"], json!("example-skill"));
        assert_eq!(
            without_content["created_by_email"],
            json!("workbench@example.com")
        );

        let with_content = metadata.to_json(true);
        assert_eq!(with_content["content"], json!("# Example"));

        let mut without_body = sample_metadata();
        without_body.content = None;
        let with_null_content = without_body.to_json(true);
        assert_eq!(with_null_content["content"], Value::Null);
    }

    #[test]
    fn discovers_declared_names_across_all_skill_roots() {
        let guard = AppRootGuard::new("all-roots");
        fs::create_dir_all(guard.root.join("skills-marketplace/vendor/market-skill"))
            .expect("create marketplace skill");
        for (path, declared_name, description) in [
            ("skills/system-skill", "declared-system", "System"),
            ("skills-user/user-skill", "declared-user", "User"),
            (
                "skills-marketplace/vendor/market-skill",
                "declared-market",
                "Marketplace",
            ),
        ] {
            let skill_dir = guard.root.join(path);
            fs::create_dir_all(&skill_dir).expect("create skill directory");
            fs::write(
                skill_dir.join("SKILL.md"),
                format!(
                    "---\nname: {declared_name}\ndescription: {description}\n---\n# {description}\n"
                ),
            )
            .expect("write skill");
        }

        let discovered = discover_skills().expect("discover skills");
        let summaries = discovered
            .iter()
            .map(|skill| {
                (
                    skill.name.as_str(),
                    skill.declared_name.as_str(),
                    skill.source.as_str(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summaries,
            vec![
                ("system-skill", "declared-system", "system"),
                ("user-skill", "declared-user", "user"),
                ("vendor/market-skill", "declared-market", "marketplace"),
            ]
        );
    }

    #[test]
    fn lists_and_resolves_safe_skill_resources() {
        let guard = AppRootGuard::new("resources");
        let skill_dir = guard.root.join("skills/example-skill");
        for directory in [
            "references",
            "scripts",
            "scripts/__pycache__",
            "assets",
            ".hidden",
        ] {
            fs::create_dir_all(skill_dir.join(directory)).expect("create resource directory");
        }
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: declared-example\ndescription: Example\n---\n# Example\n",
        )
        .expect("write skill");
        fs::write(skill_dir.join("references/guide.md"), "# Guide\n").expect("write reference");
        fs::write(skill_dir.join("scripts/run.py"), "print('ok')\n").expect("write script");
        fs::write(skill_dir.join("scripts/__init__.py"), "# package\n")
            .expect("write legitimate dunder script");
        fs::write(skill_dir.join("scripts/run.pyc"), [0x42, 0x0d])
            .expect("write generated bytecode");
        fs::write(
            skill_dir.join("scripts/__pycache__/run.cpython-314.pyc"),
            [0x42, 0x0d],
        )
        .expect("write cached bytecode");
        fs::write(skill_dir.join("assets/pixel.png"), [0x89, b'P', b'N', b'G'])
            .expect("write asset");
        fs::write(skill_dir.join("notes.txt"), "Notes\n").expect("write other resource");
        fs::write(skill_dir.join(".hidden/secret.txt"), "hidden\n").expect("write hidden");
        fs::write(skill_dir.join("references/SKILL.md"), "nested\n")
            .expect("write nested skill markdown");

        let skill = find_skill("example-skill")
            .expect("find skill")
            .expect("skill exists");
        assert_eq!(skill.declared_name, "declared-example");
        let resources = list_skill_resources(&skill).expect("list resources");
        assert_eq!(
            resources
                .iter()
                .map(|resource| (resource.relative_path.as_str(), resource.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("assets/pixel.png", "asset"),
                ("notes.txt", "other"),
                ("references/guide.md", "reference"),
                ("scripts/__init__.py", "script"),
                ("scripts/run.py", "script"),
            ]
        );
        assert_eq!(resources[0].mime_type, "image/png");
        assert_eq!(resources[0].size_bytes, 4);

        let resolved = resolve_skill_resource_path(&skill, "references/guide.md")
            .expect("resolve safe resource");
        assert_eq!(fs::read_to_string(resolved).unwrap(), "# Guide\n");
        assert_eq!(
            resolve_skill_resource_path(&skill, "missing.txt"),
            Err(SkillResourcePathError::Missing)
        );
        for invalid in [
            "",
            "../escape.txt",
            "/absolute.txt",
            ".hidden/secret.txt",
            "scripts/__pycache__/run.cpython-314.pyc",
            "scripts/run.pyc",
            "references/SKILL.md",
            "references",
            "references\\guide.md",
        ] {
            assert_eq!(
                resolve_skill_resource_path(&skill, invalid),
                Err(SkillResourcePathError::Invalid),
                "expected invalid path: {invalid}"
            );
        }
    }

    // R2-1 regression (2026-08-02): the old allowlist (md/txt/json/yaml under
    // `references/` only) hid .sql/.csv/.b64 files and the entire singular
    // `reference/` layout from list/read metadata even though the read
    // surface serves them. Enumeration now matches servability exactly.
    #[test]
    fn reference_enumeration_covers_all_servable_files_in_both_layouts() {
        let guard = AppRootGuard::new("reference-enumeration");
        let skill_dir = guard.root.join("skills-user/example-skill");
        fs::create_dir_all(skill_dir.join("references/queries")).expect("create references dir");
        fs::create_dir_all(skill_dir.join("reference/nested")).expect("create reference dir");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: example-skill\ndescription: Example\n---\n# Example\n",
        )
        .expect("write skill");
        fs::write(skill_dir.join("references/queries/top.sql"), "SELECT 1;\n")
            .expect("write sql reference");
        fs::write(skill_dir.join("references/rows.csv"), "a,b\n1,2\n").expect("write csv");
        fs::write(skill_dir.join("references/pixel.png.b64"), "aGk=\n").expect("write b64");
        fs::write(skill_dir.join("reference/nested/sdk.md"), "# SDK\n")
            .expect("write singular-layout reference");
        // Unservable entries stay unlisted: hidden files, bytecode, and
        // nested SKILL.md are all rejected by resolve_skill_resource_path.
        fs::write(skill_dir.join("references/.hidden.md"), "hidden\n").expect("write hidden");
        fs::write(skill_dir.join("references/cache.pyc"), [0x42]).expect("write bytecode");
        fs::write(
            skill_dir.join("reference/nested/SKILL.md"),
            "---\nname: phantom\ndescription: Reference material\n---\n# Phantom\n",
        )
        .expect("write nested skill markdown");

        let discovered = discover_skills().expect("discover skills");
        assert_eq!(
            discovered.len(),
            1,
            "reference-material dirs must not create phantom skills"
        );
        let skill = &discovered[0];
        assert_eq!(skill.name, "example-skill");
        assert_eq!(
            skill.references,
            vec![
                "reference/nested/sdk.md",
                "references/pixel.png.b64",
                "references/queries/top.sql",
                "references/rows.csv",
            ]
        );
        // Enumeration ⊆ servable: every advertised path resolves through the
        // same gate get_skill_reference uses.
        for reference_path in &skill.references {
            assert!(
                resolve_skill_resource_path(skill, reference_path).is_ok(),
                "advertised reference must be servable: {reference_path}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_skill_resource_symlink_escape() {
        use std::os::unix::fs::symlink;

        let guard = AppRootGuard::new("resource-symlink-escape");
        let skill_dir = guard.root.join("skills/example-skill");
        fs::create_dir_all(skill_dir.join("references")).expect("create references");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: example-skill\ndescription: Example\n---\n# Example\n",
        )
        .expect("write skill");
        let outside = guard.root.join("outside.txt");
        fs::write(&outside, "secret\n").expect("write outside file");
        symlink(&outside, skill_dir.join("references/escape.txt")).expect("create symlink");

        let skill = find_skill("example-skill")
            .expect("find skill")
            .expect("skill exists");
        assert_eq!(
            resolve_skill_resource_path(&skill, "references/escape.txt"),
            Err(SkillResourcePathError::Invalid)
        );
        assert!(list_skill_resources(&skill).unwrap().is_empty());
    }

    #[test]
    fn discover_skills_find_skill_and_validate_paths_cover_error_branches() {
        let guard = AppRootGuard::new("find-and-validate");
        let skill_dir = guard.root.join("skills/example-skill");
        fs::create_dir_all(skill_dir.join("references")).expect("create references dir");
        fs::create_dir_all(skill_dir.join("scripts")).expect("create scripts dir");
        fs::write(
            skill_dir.join("SKILL.md"),
            concat!(
                "---\n",
                "name: example-skill\n",
                "description: Example\n",
                "created_by_email: creator@example.com\n",
                "metadata:\n",
                "  priority: high\n",
                "---\n",
                "# Example\n"
            ),
        )
        .expect("write valid skill");
        fs::write(skill_dir.join("references/guide.md"), "# Guide\n").expect("write reference");
        fs::write(skill_dir.join("scripts/run.py"), "print('ok')\n").expect("write script");

        let broken_dir = guard.root.join("skills/broken-skill");
        fs::create_dir_all(&broken_dir).expect("create broken skill dir");
        fs::write(
            broken_dir.join("SKILL.md"),
            "---\nname: broken-skill\ndescription: [\n---\n# Broken\n",
        )
        .expect("write broken skill");

        let discovered = discover_skills().expect("discover skills");
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].references, vec!["references/guide.md"]);
        assert_eq!(discovered[0].scripts, vec!["scripts/run.py"]);

        let found = find_skill("example-skill")
            .expect("find skill")
            .expect("skill should exist");
        assert_eq!(
            found.created_by_email.as_deref(),
            Some("creator@example.com")
        );
        assert_eq!(
            read_skill_markdown(&found).expect("read markdown"),
            concat!(
                "---\n",
                "name: example-skill\n",
                "description: Example\n",
                "created_by_email: creator@example.com\n",
                "metadata:\n",
                "  priority: high\n",
                "---\n",
                "# Example\n"
            )
        );
        assert!(find_skill("missing-skill")
            .expect("find missing skill")
            .is_none());

        let valid_path =
            validate_skill_path("example-skill", Some("references/guide.md")).expect("valid path");
        assert!(valid_path.ends_with("skills-user/example-skill/references/guide.md"));
        assert!(validate_skill_path("", None).is_err());
        assert!(validate_skill_path("example-skill", Some("../escape")).is_err());
        assert!(validate_skill_path("example-skill", Some("/absolute")).is_err());
    }

    #[test]
    fn discover_skills_deduplicates_same_skill_name_across_sources() {
        let guard = AppRootGuard::new("dedupe");
        let system_skill_dir = guard.root.join("skills/example-skill");
        fs::create_dir_all(&system_skill_dir).expect("create system skill dir");
        fs::write(
            system_skill_dir.join("SKILL.md"),
            "---\nname: example-skill\ndescription: System description\n---\n# System\n",
        )
        .expect("write system skill");

        let user_skill_dir = guard.root.join("skills-user/example-skill");
        fs::create_dir_all(&user_skill_dir).expect("create user skill dir");
        fs::write(
            user_skill_dir.join("SKILL.md"),
            "---\nname: example-skill\ndescription: User description\n---\n# User\n",
        )
        .expect("write user skill");

        let discovered = discover_skills().expect("discover skills");
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].source, "system");
        assert_eq!(discovered[0].description, "System description");
    }

    #[test]
    fn discover_skills_skips_hidden_and_frontmatterless_entries() {
        let guard = AppRootGuard::new("hidden-and-plain");

        let hidden_dir = guard.root.join("skills/.hidden-skill");
        fs::create_dir_all(&hidden_dir).expect("create hidden skill dir");
        fs::write(
            hidden_dir.join("SKILL.md"),
            "---\nname: hidden-skill\ndescription: Hidden\n---\n# Hidden\n",
        )
        .expect("write hidden skill");

        let private_dir = guard.root.join("skills/_private-skill");
        fs::create_dir_all(&private_dir).expect("create private skill dir");
        fs::write(
            private_dir.join("SKILL.md"),
            "---\nname: private-skill\ndescription: Private\n---\n# Private\n",
        )
        .expect("write private skill");

        let plain_dir = guard.root.join("skills/plain-skill");
        fs::create_dir_all(&plain_dir).expect("create plain skill dir");
        fs::write(plain_dir.join("SKILL.md"), "# No frontmatter\n").expect("write plain skill");

        let valid_dir = guard.root.join("skills/visible-skill");
        fs::create_dir_all(&valid_dir).expect("create valid skill dir");
        fs::write(
            valid_dir.join("SKILL.md"),
            "---\nname: visible-skill\ndescription: Visible\n---\n# Visible\n",
        )
        .expect("write visible skill");

        let discovered = discover_skills().expect("discover skills");
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].name, "visible-skill");
    }

    #[test]
    fn validate_skill_path_joins_safe_nested_subpaths() {
        let guard = AppRootGuard::new("safe-subpath");
        let nested = guard
            .root
            .join("skills-user/example-skill/references/guides");
        fs::create_dir_all(&nested).expect("create nested subpath");
        fs::write(nested.join("start.md"), "# Start\n").expect("write nested subpath file");
        fs::create_dir_all(guard.root.join("skills-user/example-skill"))
            .expect("create base skill directory");

        let joined =
            validate_skill_path("example-skill", Some("references/guides/start.md")).unwrap();
        assert_eq!(
            fs::canonicalize(joined).unwrap(),
            fs::canonicalize(
                guard
                    .root
                    .join("skills-user/example-skill/references/guides/start.md")
            )
            .unwrap()
        );

        let base_only = validate_skill_path("example-skill", None).unwrap();
        assert_eq!(
            fs::canonicalize(base_only).unwrap(),
            fs::canonicalize(guard.root.join("skills-user/example-skill")).unwrap()
        );
    }

    #[test]
    fn derive_skill_name_and_split_frontmatter_cover_edge_cases() {
        let guard = AppRootGuard::new("derive-and-frontmatter");
        let system_root = guard.root.join("skills");
        let user_root = guard.root.join("skills-user");
        let marketplace_root = guard.root.join("skills-marketplace");

        assert_eq!(
            derive_skill_name(
                &system_root,
                &system_root.join("example-skill/SKILL.md"),
                "system"
            )
            .as_deref(),
            Some("example-skill")
        );
        assert_eq!(
            derive_skill_name(
                &marketplace_root,
                &marketplace_root.join("vendor/example-skill/SKILL.md"),
                "marketplace"
            )
            .as_deref(),
            Some("vendor/example-skill")
        );
        assert_eq!(
            derive_skill_name(&user_root, &user_root.join(".hidden/SKILL.md"), "user"),
            None
        );
        assert_eq!(
            derive_skill_name(
                &marketplace_root,
                &marketplace_root.join("vendor/SKILL.md"),
                "marketplace"
            ),
            None
        );
        assert_eq!(
            derive_skill_name(
                Path::new("/different-root"),
                &system_root.join("example-skill/SKILL.md"),
                "system"
            ),
            None
        );

        let (frontmatter, body) = split_frontmatter("plain body\n");
        assert_eq!(frontmatter, None);
        assert_eq!(body, "plain body");

        let (frontmatter, body) = split_frontmatter("---\nname: demo\nunterminated");
        assert_eq!(frontmatter, None);
        assert!(body.is_empty());
    }

    #[test]
    fn parse_skill_file_and_markdown_helpers_cover_none_and_error_paths() {
        let guard = AppRootGuard::new("parse-edges");

        let plain_dir = guard.root.join("skills/plain");
        fs::create_dir_all(&plain_dir).expect("create plain dir");
        let plain_skill = plain_dir.join("SKILL.md");
        fs::write(&plain_skill, "# No frontmatter\n").expect("write plain skill");
        assert!(parse_skill_file(&plain_skill, "system", "plain")
            .expect("plain skill should parse")
            .is_none());

        let sibling_yaml_dir = guard.root.join("skills/sibling-yaml");
        fs::create_dir_all(&sibling_yaml_dir).expect("create sibling yaml dir");
        let sibling_yaml_skill = sibling_yaml_dir.join("SKILL.md");
        fs::write(&sibling_yaml_skill, "# Raw body\n").expect("write sibling yaml skill");
        fs::write(
            sibling_yaml_dir.join("sibling-yaml.yaml"),
            concat!(
                "skill_name: sibling-yaml\n",
                "description: Sibling metadata skill\n",
                "topic: trino\n",
                "domain: data platform\n",
                "owner: Data Platform\n",
            ),
        )
        .expect("write sibling yaml metadata");
        let sibling_yaml_parsed = parse_skill_file(&sibling_yaml_skill, "system", "sibling-yaml")
            .expect("parse sibling yaml skill")
            .expect("sibling yaml skill metadata");
        assert_eq!(sibling_yaml_parsed.description, "Sibling metadata skill");
        assert_eq!(sibling_yaml_parsed.author.as_deref(), Some("Data Platform"));
        assert_eq!(sibling_yaml_parsed.priority, "medium");
        assert_eq!(
            sibling_yaml_parsed.triggers,
            vec!["trino".to_string(), "data platform".to_string()]
        );
        assert_eq!(
            sibling_yaml_parsed.required_mcp_servers,
            Vec::<String>::new()
        );
        assert_eq!(sibling_yaml_parsed.content.as_deref(), Some("# Raw body\n"));

        let missing_skill_name_dir = guard.root.join("skills/missing-sibling-skill-name");
        fs::create_dir_all(&missing_skill_name_dir).expect("create missing sibling skill name dir");
        let missing_skill_name_skill = missing_skill_name_dir.join("SKILL.md");
        fs::write(&missing_skill_name_skill, "# Missing name\n").expect("write missing name skill");
        fs::write(
            missing_skill_name_dir.join("missing-sibling-skill-name.yaml"),
            concat!(
                "description: Missing skill_name\n",
                "topic: trino\n",
                "domain: data platform\n",
            ),
        )
        .expect("write missing skill_name yaml");
        assert!(parse_skill_file(
            &missing_skill_name_skill,
            "system",
            "missing-sibling-skill-name"
        )
        .expect("parse missing skill_name sibling yaml")
        .is_none());

        let non_map_dir = guard.root.join("skills/non-map");
        fs::create_dir_all(&non_map_dir).expect("create non-map dir");
        let non_map_skill = non_map_dir.join("SKILL.md");
        fs::write(&non_map_skill, "---\n- just\n- a\n- list\n---\nbody\n")
            .expect("write non-map skill");
        assert!(parse_skill_file(&non_map_skill, "system", "non-map")
            .expect("non-map skill should parse")
            .is_none());

        let missing_fields_dir = guard.root.join("skills/missing-fields");
        fs::create_dir_all(&missing_fields_dir).expect("create missing-fields dir");
        let missing_fields_skill = missing_fields_dir.join("SKILL.md");
        fs::write(
            &missing_fields_skill,
            "---\nname: missing-fields\n---\nbody\n",
        )
        .expect("write missing-fields skill");
        assert!(
            parse_skill_file(&missing_fields_skill, "system", "missing-fields")
                .expect("missing-fields skill should parse")
                .is_none()
        );

        let invalid_yaml_dir = guard.root.join("skills/invalid-yaml");
        fs::create_dir_all(&invalid_yaml_dir).expect("create invalid-yaml dir");
        let invalid_yaml_skill = invalid_yaml_dir.join("SKILL.md");
        fs::write(
            &invalid_yaml_skill,
            "---\nname: invalid\ndescription: [\n---\nbody\n",
        )
        .expect("write invalid yaml skill");
        assert!(parse_skill_file(&invalid_yaml_skill, "system", "invalid-yaml").is_err());

        let default_metadata_dir = guard.root.join("skills/default-metadata");
        fs::create_dir_all(&default_metadata_dir).expect("create default metadata dir");
        let default_metadata_skill = default_metadata_dir.join("SKILL.md");
        fs::write(
            &default_metadata_skill,
            concat!(
                "---\n",
                "name: default-metadata\n",
                "description: Default metadata example\n",
                "---\n",
                "# Default metadata\n"
            ),
        )
        .expect("write default metadata skill");
        let parsed = parse_skill_file(&default_metadata_skill, "system", "default-metadata")
            .expect("parse default metadata skill")
            .expect("skill metadata");
        assert_eq!(parsed.priority, "medium");
        assert!(parsed.references.is_empty());
        assert!(parsed.scripts.is_empty());

        let duplicate_keys_dir = guard.root.join("skills/duplicate-keys");
        fs::create_dir_all(&duplicate_keys_dir).expect("create duplicate keys dir");
        let duplicate_keys_skill = duplicate_keys_dir.join("SKILL.md");
        fs::write(
            &duplicate_keys_skill,
            concat!(
                "---\n",
                "name: duplicate-keys\n",
                "description: Duplicate key compatibility\n",
                "display_name: Duplicate Keys\n",
                "version: 2.1\n",
                "priority: low\n",
                "priority: high\n",
                "author: first-author\n",
                "author: second-author\n",
                "triggers:\n",
                "  - trino\n",
                "---\n",
                "# Duplicate Keys\n"
            ),
        )
        .expect("write duplicate keys skill");
        let duplicate_parsed = parse_skill_file(&duplicate_keys_skill, "system", "duplicate-keys")
            .expect("parse duplicate keys skill")
            .expect("duplicate skill metadata");
        assert_eq!(duplicate_parsed.priority, "high");
        assert_eq!(
            duplicate_parsed.display_name.as_deref(),
            Some("Duplicate Keys")
        );
        assert_eq!(duplicate_parsed.version.as_deref(), Some("2.1"));
        assert_eq!(duplicate_parsed.author.as_deref(), Some("second-author"));
        assert_eq!(duplicate_parsed.triggers, vec!["trino".to_string()]);

        let mut missing_markdown = sample_metadata();
        missing_markdown.path = guard
            .root
            .join("skills/missing-markdown")
            .to_string_lossy()
            .to_string();
        let error = read_skill_markdown(&missing_markdown).unwrap_err();
        assert!(error.to_string().contains("failed to read"));
    }

    #[test]
    fn derive_skill_name_supports_plugin_layout_with_parent_guard() {
        let guard = AppRootGuard::new("plugin-layout");
        let marketplace_root = guard.root.join("skills-marketplace");

        // Depth-4 without a parent SKILL.md: plugin-layout skill.
        assert_eq!(
            derive_skill_name(
                &marketplace_root,
                &marketplace_root.join("kwp/document-skills/pdf/SKILL.md"),
                "marketplace"
            )
            .as_deref(),
            Some("kwp/document-skills/pdf")
        );

        // Parent-guard: when {mp}/{plugin} is itself a skill, the deeper
        // SKILL.md is reference material and must NOT register.
        let flat_skill_dir = marketplace_root.join("kwp/contact-center");
        fs::create_dir_all(flat_skill_dir.join("android")).expect("create nested dir");
        fs::write(
            flat_skill_dir.join("SKILL.md"),
            "---\nname: contact-center\ndescription: Skill\n---\n# Skill\n",
        )
        .expect("write flat skill");
        fs::write(
            flat_skill_dir.join("android/SKILL.md"),
            "---\nname: android\ndescription: Reference\n---\n# Reference\n",
        )
        .expect("write nested reference");
        assert_eq!(
            derive_skill_name(
                &marketplace_root,
                &marketplace_root.join("kwp/contact-center/android/SKILL.md"),
                "marketplace"
            ),
            None
        );

        // Depth 5+ never registers.
        assert_eq!(
            derive_skill_name(
                &marketplace_root,
                &marketplace_root.join("kwp/plugin/skill/references/SKILL.md"),
                "marketplace"
            ),
            None
        );
    }

    #[test]
    fn find_skill_resolves_legacy_two_segment_ids_uniquely() {
        let guard = AppRootGuard::new("legacy-id-fallback");
        for (path, name) in [
            ("skills-marketplace/kwp/document-skills/pdf", "pdf"),
            ("skills-marketplace/kwp/example-skills/art", "art"),
            ("skills-marketplace/kwp/other-plugin/art", "art"),
        ] {
            let dir = guard.root.join(path);
            fs::create_dir_all(&dir).expect("create plugin skill dir");
            fs::write(
                dir.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: D\n---\n# {name}\n"),
            )
            .expect("write plugin skill");
        }

        // Exact 3-segment id resolves directly.
        assert_eq!(
            find_skill("kwp/document-skills/pdf")
                .expect("find fqn")
                .map(|skill| skill.name),
            Some("kwp/document-skills/pdf".to_string())
        );
        // Legacy 2-segment id resolves through the unique-match fallback.
        assert_eq!(
            find_skill("kwp/pdf")
                .expect("find legacy id")
                .map(|skill| skill.name),
            Some("kwp/document-skills/pdf".to_string())
        );
        // A leaf that exists in two plugins is ambiguous: None, never a guess.
        assert!(find_skill("kwp/art").expect("ambiguous lookup").is_none());
        // Unknown ids still miss.
        assert!(find_skill("kwp/missing").expect("missing lookup").is_none());
    }

    #[test]
    fn parse_skill_file_normalizes_structured_and_malformed_triggers() {
        let guard = AppRootGuard::new("structured-triggers");
        let skill_dir = guard.root.join("skills-marketplace/vendor/smart-slides");
        fs::create_dir_all(&skill_dir).expect("create structured trigger skill dir");
        let skill_md = skill_dir.join("SKILL.md");
        fs::write(
            &skill_md,
            concat!(
                "---\n",
                "name: smart-slides\n",
                "description: Structured trigger compatibility\n",
                "triggers:\n",
                "  - ' deck '\n",
                "  - keywords:\n",
                "      - iql query\n",
                "      - ' data pull '\n",
                "      - CTR\n",
                "      - ctr\n",
                "      - 42\n",
                "  - keywords: single trigger\n",
                "  - unsupported: ignored\n",
                "  - false\n",
                "---\n",
                "# Smart Slides\n",
            ),
        )
        .expect("write structured trigger skill");

        let parsed = parse_skill_file(&skill_md, "marketplace", "vendor/smart-slides")
            .expect("parse structured trigger skill")
            .expect("structured trigger metadata");

        assert_eq!(
            parsed.triggers,
            vec![
                "deck".to_string(),
                "iql query".to_string(),
                "data pull".to_string(),
                "CTR".to_string(),
                "single trigger".to_string(),
            ]
        );
    }
}
