use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs;
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom};
#[cfg(unix)]
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use mime_guess::MimeGuess;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
#[cfg(unix)]
use rustix::fs::{mkdirat, open, openat, statat, AtFlags, FileType, Mode, OFlags};
#[cfg(unix)]
use rustix::io::{dup, Errno};
use serde_json::{json, Value};
use walkdir::WalkDir;
use zip::ZipArchive;

use super::*;

#[derive(Debug)]
struct WorkspaceFileInfo {
    file_name: String,
    file_path: String,
    file_size: u64,
    file_size_formatted: String,
    chat_id: String,
    download_url: String,
    is_inline_image: bool,
}

const WORKSPACE_URL_SEGMENT_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'\'')
    .add(b'(')
    .add(b')')
    .add(b'*')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

pub(crate) const UNSAFE_ARCHIVE_PATH_ERROR_CODE: &str = "UNSAFE_ARCHIVE_PATH";
const MAX_ARCHIVE_MEMBER_PREVIEW_CHARS: usize = 160;

#[derive(Debug)]
pub(crate) struct UnsafeArchivePathError {
    member: String,
}

impl UnsafeArchivePathError {
    fn new(member: &str) -> Self {
        Self {
            member: archive_member_preview(member),
        }
    }

    fn from_bytes(member: &[u8]) -> Self {
        Self::new(String::from_utf8_lossy(member).as_ref())
    }

    fn from_preview(member: &str) -> Self {
        Self {
            member: member.to_string(),
        }
    }

    pub(crate) fn member(&self) -> &str {
        &self.member
    }
}

impl fmt::Display for UnsafeArchivePathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "archive contains an unsafe member path: {}",
            self.member
        )
    }
}

impl std::error::Error for UnsafeArchivePathError {}

fn archive_member_preview(member: &str) -> String {
    if member.is_empty() {
        return "<empty>".to_string();
    }

    let mut preview = String::new();
    let mut chars = member.chars();
    for character in chars.by_ref().take(MAX_ARCHIVE_MEMBER_PREVIEW_CHARS) {
        preview.extend(character.escape_default());
    }
    if chars.next().is_some() {
        preview.push_str("...");
    }
    preview
}

fn validate_archive_name_bytes(
    name: &[u8],
    allow_terminal_slash: bool,
) -> std::result::Result<(), UnsafeArchivePathError> {
    let unsafe_error = || UnsafeArchivePathError::from_bytes(name);
    if name.is_empty()
        || name.contains(&0)
        || name.contains(&b'\\')
        || name.starts_with(b"/")
        || (name.len() >= 2 && name[0].is_ascii_alphabetic() && name[1] == b':')
    {
        return Err(unsafe_error());
    }

    let body = if allow_terminal_slash && name.ends_with(b"/") {
        &name[..name.len() - 1]
    } else {
        name
    };
    if body.is_empty()
        || body
            .split(|byte| *byte == b'/')
            .any(|component| component.is_empty() || component == b"." || component == b"..")
    {
        return Err(unsafe_error());
    }
    Ok(())
}

fn validated_effective_archive_parts(
    name: &str,
    is_directory: bool,
) -> std::result::Result<Vec<OsString>, UnsafeArchivePathError> {
    validate_archive_name_bytes(name.as_bytes(), is_directory)?;
    let body = if is_directory {
        name.strip_suffix('/').unwrap_or(name)
    } else {
        name
    };
    Ok(body.split('/').map(OsString::from).collect())
}

fn vm_tmp_root(vm: &VmInfo) -> Result<PathBuf> {
    Ok(resolve_local_work_bind_source(vm)?.join(".tmp"))
}

pub(crate) fn vm_host_path(vm: &VmInfo, path: &str) -> Result<PathBuf> {
    let normalized = normalize_vm_path(path);
    let (root, relative) = if normalized.starts_with("/tmp") {
        (
            vm_tmp_root(vm)?,
            normalized
                .trim_start_matches("/tmp")
                .trim_start_matches('/'),
        )
    } else if normalized.starts_with("/workspace") {
        (
            resolve_local_work_bind_source(vm)?,
            normalized
                .trim_start_matches("/workspace")
                .trim_start_matches('/'),
        )
    } else if normalized.starts_with("/work") {
        (
            resolve_local_work_bind_source(vm)?,
            normalized
                .trim_start_matches("/work")
                .trim_start_matches('/'),
        )
    } else {
        bail!("path must be within /work or /tmp");
    };
    let host_path = root.join(relative);
    ensure_within(&root, &host_path)?;
    Ok(host_path)
}

pub(crate) fn workspace_relative_path(vm: &VmInfo, workspace_path: &str) -> Result<PathBuf> {
    let relative = sanitize_workspace_relative(workspace_path, false)?;
    reject_private_workspace_root(&vm.chat_id, &relative)?;
    let root = container_chat_workspace_root(&vm.chat_id)?;
    let path = root.join(relative);
    ensure_within(&root, &path)?;
    Ok(path)
}

pub(crate) fn ensure_within(root: &Path, candidate: &Path) -> Result<()> {
    let normalized_root = lexical_normalize(root);
    let normalized_candidate = lexical_normalize(candidate);
    if normalized_candidate.starts_with(&normalized_root) {
        return Ok(());
    }

    let root = match root.canonicalize() {
        Ok(path) => path,
        Err(_) => normalized_root,
    };
    let current = match nearest_existing_ancestor(candidate).canonicalize() {
        Ok(path) => path,
        Err(_) => normalized_candidate,
    };
    if !current.starts_with(&root) {
        bail!("path escapes workspace");
    }
    Ok(())
}

fn nearest_existing_ancestor(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    loop {
        if current.exists() {
            return current;
        }
        let Some(parent) = current.parent() else {
            return current;
        };
        if parent == current {
            return current;
        }
        current = parent.to_path_buf();
    }
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => {
                normalized.push(std::path::MAIN_SEPARATOR.to_string());
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

pub(crate) fn normalize_vm_path(path: &str) -> String {
    if path.starts_with('/') {
        if let Some(rest) = path.strip_prefix("/workspace") {
            format!("/work{rest}")
        } else {
            path.to_string()
        }
    } else {
        format!("/work/{path}")
    }
}

fn validate_container_vm_path(path: &str) -> Result<String> {
    let normalized = normalize_vm_path(path);
    if normalized == "/work"
        || normalized.starts_with("/work/")
        || normalized == "/tmp"
        || normalized.starts_with("/tmp/")
    {
        Ok(normalized)
    } else {
        bail!("path must be within /work or /tmp")
    }
}

async fn vm_python_json(vm: &VmInfo, script: &str, payload: Value) -> Result<Value> {
    let script_arg = BASE64_STANDARD.encode(script.as_bytes());
    let payload_arg = BASE64_STANDARD.encode(serde_json::to_vec(&payload)?);
    let output = exec_argv_in_vm(
        vm,
        &[
            "python3".to_string(),
            "-c".to_string(),
            "import base64,sys; exec(base64.b64decode(sys.argv[1]).decode('utf-8'))".to_string(),
            script_arg,
            payload_arg,
        ],
    )
    .await?;
    if output.exit_code != 0 {
        bail!(
            "VM file operation failed: {}",
            output.stderr.trim().to_string()
        );
    }
    serde_json::from_str(output.stdout.trim()).context("VM file operation returned invalid JSON")
}

pub(crate) const VM_FILE_SCRIPT: &str = r#"
import base64, errno, fnmatch, json, os, re, shutil, stat, sys, time, zipfile

payload = json.loads(base64.b64decode(sys.argv[2]).decode("utf-8"))

def normalize(path):
    path = str(path or "")
    if not path.startswith("/"):
        path = "/work/" + path
    if path.startswith("/workspace"):
        path = "/work" + path[len("/workspace"):]
    path = os.path.normpath(path)
    if path in ("/work", "/tmp") or path.startswith("/work/") or path.startswith("/tmp/"):
        return path
    raise ValueError("path must be within /work or /tmp")

def checked(path, for_create=False):
    path = normalize(path)
    root = "/tmp" if path == "/tmp" or path.startswith("/tmp/") else "/work"
    root_real = os.path.realpath(root)
    candidate = os.path.normpath(path)
    parent = candidate if not for_create else os.path.dirname(candidate)
    current = parent
    while current and not os.path.exists(current):
        next_current = os.path.dirname(current)
        if next_current == current:
            break
        current = next_current
    current_real = os.path.realpath(current or root)
    if current_real != root_real and not current_real.startswith(root_real + os.sep):
        raise ValueError("path escapes workspace")
    if os.path.exists(candidate):
        real = os.path.realpath(candidate)
        if real != root_real and not real.startswith(root_real + os.sep):
            raise ValueError("path escapes workspace")
    return candidate

def rel(path):
    path = normalize(path)
    root = "/tmp" if path == "/tmp" or path.startswith("/tmp/") else "/work"
    relative = os.path.relpath(path, root)
    if relative == ".":
        return root
    return root + "/" + relative.replace(os.sep, "/")

class UnsafeArchivePath(Exception):
    def __init__(self, member):
        self.member = archive_member_preview(member)
        super().__init__(self.member)

def archive_member_preview(member):
    member = str(member or "")
    if not member:
        return "<empty>"
    preview = member[:160].encode("unicode_escape", "backslashreplace").decode("ascii")
    if len(member) > 160:
        preview += "..."
    return preview

def validate_archive_member_name(name, is_directory):
    name = str(name or "")
    if (not name or "\x00" in name or "\\" in name or name.startswith("/")
            or re.match(r"^[A-Za-z]:", name)):
        raise UnsafeArchivePath(name)
    parts = name.split("/")
    if is_directory and parts and parts[-1] == "":
        parts.pop()
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise UnsafeArchivePath(name)
    return parts

def unsafe_archive_payload(member):
    return {
        "success": False,
        "error_code": "UNSAFE_ARCHIVE_PATH",
        "unsafe_member": member,
        "error": "Archive contains an unsafe member path.",
    }

def archive_path_error(error, member):
    if error.errno in (errno.ELOOP, errno.ENOTDIR):
        raise UnsafeArchivePath(member) from error
    raise error

def open_directory_at(parent_fd, component, member=None, create=False):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        return os.open(component, flags, dir_fd=parent_fd)
    except FileNotFoundError:
        if not create:
            raise
        try:
            os.mkdir(component, 0o755, dir_fd=parent_fd)
        except FileExistsError:
            pass
        try:
            return os.open(component, flags, dir_fd=parent_fd)
        except OSError as error:
            if member is not None:
                archive_path_error(error, member)
            raise
    except OSError as error:
        if member is not None:
            archive_path_error(error, member)
        raise

def open_directory_path(start_fd, parts, member=None, create=False):
    current_fd = os.dup(start_fd)
    try:
        for component in parts:
            next_fd = open_directory_at(current_fd, component, member, create)
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except Exception:
        os.close(current_fd)
        raise

def verify_existing_member_path(dest_fd, parts, member, is_directory):
    current_fd = os.dup(dest_fd)
    try:
        for index, component in enumerate(parts):
            try:
                metadata = os.stat(component, dir_fd=current_fd, follow_symlinks=False)
            except FileNotFoundError:
                return
            if stat.S_ISLNK(metadata.st_mode):
                raise UnsafeArchivePath(member)
            is_last = index == len(parts) - 1
            if is_last:
                if is_directory and not stat.S_ISDIR(metadata.st_mode):
                    raise NotADirectoryError(component)
                if not is_directory and stat.S_ISDIR(metadata.st_mode):
                    raise IsADirectoryError(component)
                return
            if not stat.S_ISDIR(metadata.st_mode):
                raise NotADirectoryError(component)
            next_fd = open_directory_at(current_fd, component, member, False)
            os.close(current_fd)
            current_fd = next_fd
    finally:
        os.close(current_fd)

def unzip_archive(zip_path, dest, strip):
    try:
        with zipfile.ZipFile(zip_path) as archive:
            plans = []
            effective_names = set()
            for member in archive.infolist():
                original_name = member.orig_filename
                validate_archive_member_name(
                    original_name,
                    str(original_name).endswith("/"),
                )
                effective_name = member.filename
                parts = validate_archive_member_name(effective_name, member.is_dir())
                if effective_name in effective_names:
                    raise UnsafeArchivePath(effective_name)
                effective_names.add(effective_name)
                retained = parts[strip:]
                if retained:
                    plans.append((member, retained, effective_name))

            root = "/tmp" if dest == "/tmp" or dest.startswith("/tmp/") else "/work"
            relative_dest = os.path.relpath(dest, root)
            dest_parts = [] if relative_dest == "." else relative_dest.split(os.sep)
            root_fd = os.open(os.path.realpath(root), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                dest_fd = open_directory_path(root_fd, dest_parts, create=True)
            finally:
                os.close(root_fd)
            try:
                for member, parts, effective_name in plans:
                    verify_existing_member_path(
                        dest_fd, parts, effective_name, member.is_dir()
                    )

                extracted = 0
                for member, parts, effective_name in plans:
                    if member.is_dir():
                        directory_fd = open_directory_path(
                            dest_fd, parts, effective_name, True
                        )
                        os.close(directory_fd)
                        continue
                    parent_fd = open_directory_path(
                        dest_fd, parts[:-1], effective_name, True
                    )
                    try:
                        try:
                            output_fd = os.open(
                                parts[-1],
                                os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW,
                                0o666,
                                dir_fd=parent_fd,
                            )
                        except OSError as error:
                            archive_path_error(error, effective_name)
                        with archive.open(member) as source, os.fdopen(output_fd, "wb") as output:
                            shutil.copyfileobj(source, output)
                    finally:
                        os.close(parent_fd)
                    extracted += 1

                top_files, top_dirs = [], []
                for name in os.listdir(dest_fd):
                    metadata = os.stat(name, dir_fd=dest_fd, follow_symlinks=False)
                    if stat.S_ISDIR(metadata.st_mode):
                        top_dirs.append(name)
                    else:
                        top_files.append(name)
                top_files.sort()
                top_dirs.sort()
                return {
                    "success": True,
                    "zip_path": rel(zip_path),
                    "dest_path": rel(dest),
                    "files_extracted": extracted,
                    "top_level_files": top_files,
                    "top_level_directories": top_dirs,
                }
            finally:
                os.close(dest_fd)
    except UnsafeArchivePath as error:
        return unsafe_archive_payload(error.member)

op = payload.get("op")
if op == "read":
    path = checked(payload.get("path"))
    with open(path, "rb") as handle:
        data = handle.read()
    print(json.dumps({"success": True, "path": rel(path), "content_base64": base64.b64encode(data).decode("ascii")}))
elif op == "write":
    path = checked(payload.get("path"), True)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = "ab" if payload.get("append") else "wb"
    with open(path, mode) as handle:
        handle.write(base64.b64decode(payload.get("content_base64") or ""))
    print(json.dumps({"success": True, "path": rel(path)}))
elif op == "stat":
    path = checked(payload.get("path"), payload.get("for_create", False))
    if not os.path.exists(path):
        print(json.dumps({"success": True, "exists": False, "path": rel(path)}))
    else:
        stat = os.stat(path)
        print(json.dumps({"success": True, "exists": True, "path": rel(path), "is_dir": os.path.isdir(path), "is_file": os.path.isfile(path), "size": stat.st_size, "modified_time": stat.st_mtime}))
elif op == "delete_file":
    path = checked(payload.get("path"))
    if os.path.isfile(path):
        os.remove(path)
        deleted = True
    else:
        deleted = False
    print(json.dumps({"success": True, "deleted": deleted, "path": rel(path)}))
elif op == "list":
    root = checked(payload.get("path") or "/work")
    if not os.path.isdir(root):
        print(json.dumps({"success": False, "error": "Directory not found"}))
    else:
        recursive = bool(payload.get("recursive"))
        files, directories, entries = [], [], []
        if recursive:
            iterator = []
            for base, dirnames, filenames in os.walk(root):
                for dirname in dirnames:
                    iterator.append(os.path.join(base, dirname))
                for filename in filenames:
                    iterator.append(os.path.join(base, filename))
        else:
            iterator = [os.path.join(root, name) for name in os.listdir(root)]
        for item in iterator:
            name = os.path.basename(item)
            item_rel = rel(item)
            stat = os.stat(item)
            is_dir = os.path.isdir(item)
            if is_dir:
                directories.append(name)
            else:
                files.append(name)
            entries.append({"name": name, "path": item_rel, "kind": "directory" if is_dir else "file", "size": stat.st_size, "modified_time": stat.st_mtime})
        print(json.dumps({"success": True, "directory": rel(root), "files": files, "directories": directories, "entries": entries}))
elif op == "find":
    root = checked(payload.get("path") or "/work")
    pattern = payload.get("pattern") or "*"
    max_results = max(1, int(payload.get("max_results") or 100))
    matches = []
    for base, _, filenames in os.walk(root):
        for filename in filenames:
            path = os.path.join(base, filename)
            if fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(filename, pattern):
                matches.append((os.path.getmtime(path), rel(path)))
    matches.sort(reverse=True)
    selected = [item[1] for item in matches[:max_results]]
    print(json.dumps({"success": True, "files": selected, "count": len(selected), "truncated": len(matches) > max_results}))
elif op == "grep":
    root = checked(payload.get("path") or "/work")
    flags = re.IGNORECASE if payload.get("case_insensitive") else 0
    regex = re.compile(payload.get("pattern") or "", flags)
    file_pattern = payload.get("file_pattern")
    max_results = max(1, int(payload.get("max_results") or 50))
    output_mode = payload.get("output_mode") or "content"
    matches, files, counts = [], [], {}
    total = 0
    for base, _, filenames in os.walk(root):
        for filename in filenames:
            path = os.path.join(base, filename)
            if file_pattern and not fnmatch.fnmatch(filename, file_pattern) and not fnmatch.fnmatch(path, file_pattern):
                continue
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    content = handle.read()
            except Exception:
                continue
            found = list(regex.finditer(content))
            if not found:
                continue
            vm_path = rel(path)
            files.append(vm_path)
            counts[vm_path] = len(found)
            total += len(found)
            if output_mode != "files":
                lines = content.splitlines()
                for line_no, line in enumerate(lines, 1):
                    if regex.search(line):
                        matches.append(f"{vm_path}:{line_no}:{line}")
                        if len(matches) >= max_results:
                            break
            if len(matches) >= max_results:
                break
        if len(matches) >= max_results:
            break
    print(json.dumps({"success": True, "matches": matches, "files": files, "counts": counts, "total_matches": total, "truncated": len(matches) >= max_results}))
elif op == "unzip":
    zip_path = checked(payload.get("zip_path"))
    dest = checked(payload.get("dest_path") or "/work", True)
    strip = max(0, int(payload.get("strip_components") or 0))
    print(json.dumps(unzip_archive(zip_path, dest, strip)))
else:
    raise ValueError("unknown file operation")
"#;

pub(crate) async fn vm_read_bytes(vm: &VmInfo, path: &str) -> Result<(String, Vec<u8>)> {
    if fake_docker_enabled() {
        let host_path = vm_host_path(vm, path)?;
        let bytes = fs::read(&host_path)?;
        return Ok((vm_path_string(vm, &host_path)?, bytes));
    }
    let normalized = validate_container_vm_path(path)?;
    let response = vm_python_json(
        vm,
        VM_FILE_SCRIPT,
        json!({"op": "read", "path": normalized}),
    )
    .await?;
    let content = response
        .get("content_base64")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Ok((
        response
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or(&normalized)
            .to_string(),
        BASE64_STANDARD.decode(content.as_bytes())?,
    ))
}

pub(crate) async fn vm_write_bytes(
    vm: &VmInfo,
    path: &str,
    bytes: &[u8],
    append: bool,
) -> Result<String> {
    if fake_docker_enabled() {
        let host_path = vm_host_path(vm, path)?;
        fs::create_dir_all(host_path.parent().context("file path missing parent")?)?;
        if append {
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&host_path)?;
            use std::io::Write as _;
            file.write_all(bytes)?;
        } else {
            fs::write(&host_path, bytes)?;
        }
        return vm_path_string(vm, &host_path);
    }
    let normalized = validate_container_vm_path(path)?;
    let response = vm_python_json(
        vm,
        VM_FILE_SCRIPT,
        json!({"op": "write", "path": normalized, "content_base64": BASE64_STANDARD.encode(bytes), "append": append}),
    )
    .await?;
    Ok(response
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or(&normalized)
        .to_string())
}

pub(crate) async fn vm_stat(vm: &VmInfo, path: &str) -> Result<Value> {
    if fake_docker_enabled() {
        let host_path = vm_host_path(vm, path)?;
        if !host_path.exists() {
            return Ok(json!({"success": true, "exists": false, "path": normalize_vm_path(path)}));
        }
        let metadata = host_path.metadata()?;
        return Ok(json!({
            "success": true,
            "exists": true,
            "path": vm_path_string(vm, &host_path)?,
            "is_dir": metadata.is_dir(),
            "is_file": metadata.is_file(),
            "size": metadata.len(),
            "modified_time": metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|duration| duration.as_secs_f64()).unwrap_or(0.0),
        }));
    }
    let normalized = validate_container_vm_path(path)?;
    vm_python_json(
        vm,
        VM_FILE_SCRIPT,
        json!({"op": "stat", "path": normalized}),
    )
    .await
}

pub(crate) async fn vm_delete_regular_file(vm: &VmInfo, path: &str) -> Result<bool> {
    if fake_docker_enabled() {
        let host_path = vm_host_path(vm, path)?;
        return Ok(host_path.is_file() && fs::remove_file(&host_path).is_ok());
    }
    let normalized = validate_container_vm_path(path)?;
    let response = vm_python_json(
        vm,
        VM_FILE_SCRIPT,
        json!({"op": "delete_file", "path": normalized}),
    )
    .await?;
    Ok(response
        .get("deleted")
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

pub(crate) fn sanitize_relative(path: &str) -> Result<String> {
    let cleaned = path.trim().trim_start_matches('/').replace('\\', "/");
    if cleaned.split('/').any(|part| part == "..") {
        bail!("path traversal is not allowed");
    }
    Ok(cleaned)
}

pub(crate) fn sanitize_workspace_relative(path: &str, allow_empty: bool) -> Result<String> {
    let cleaned = sanitize_relative(path)?;
    if cleaned.is_empty() {
        if allow_empty {
            return Ok(cleaned);
        }
        bail!("path is required");
    }
    Ok(cleaned)
}

pub(crate) fn live_vm_roots_for_chat(chat_id: &str) -> Result<HashSet<String>> {
    Ok(list_managed_vm_infos()?
        .into_iter()
        .filter(|vm| vm.chat_id == chat_id && is_usable_container_status(&vm.status))
        .map(|vm| vm.vm_id)
        .collect())
}

pub(crate) fn private_workspace_root_segment(
    chat_id: &str,
    relative_path: &str,
) -> Result<Option<String>> {
    let Some(first_segment) = relative_path.split('/').next() else {
        return Ok(None);
    };
    if first_segment.is_empty() {
        return Ok(None);
    }
    Ok(live_vm_roots_for_chat(chat_id)?
        .contains(first_segment)
        .then(|| first_segment.to_string()))
}

pub(crate) fn reject_private_workspace_root(chat_id: &str, relative_path: &str) -> Result<()> {
    if let Some(vm_id) = private_workspace_root_segment(chat_id, relative_path)? {
        bail!("path points to a private VM workspace: {vm_id}");
    }
    Ok(())
}

fn encode_workspace_url_segment(segment: &str) -> String {
    utf8_percent_encode(segment, WORKSPACE_URL_SEGMENT_ENCODE_SET).to_string()
}

fn workspace_file_server_url(base_url: &str, chat_id: &str, file_path: &str) -> Result<String> {
    let encoded_path = sanitize_workspace_relative(file_path, false)?
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(encode_workspace_url_segment)
        .collect::<Vec<_>>()
        .join("/");

    let encoded_chat_id = encode_workspace_url_segment(chat_id.trim());
    let base_url = base_url.trim_end_matches('/');

    Ok(if encoded_path.is_empty() {
        format!("{base_url}/workspace/{encoded_chat_id}")
    } else {
        format!("{base_url}/workspace/{encoded_chat_id}/{encoded_path}")
    })
}

pub(crate) fn workspace_download_url(chat_id: &str, file_path: &str) -> Result<String> {
    workspace_file_server_url("http://localhost:9876", chat_id, file_path)
}

pub(crate) fn workspace_browser_url(
    chat_id: &str,
    file_path: &str,
    is_image: bool,
) -> Result<String> {
    let download_url = workspace_download_url(chat_id, file_path)?;
    Ok(if is_image {
        format!("{download_url}?inline=1")
    } else {
        download_url
    })
}

pub(crate) fn workspace_model_image_url(chat_id: &str, file_path: &str) -> Result<String> {
    workspace_file_server_url("http://host.docker.internal:9876", chat_id, file_path)
}

pub(crate) fn vm_path_string(vm: &VmInfo, host_path: &Path) -> Result<String> {
    if let Ok(relative) = host_path.strip_prefix(resolve_local_work_bind_source(vm)?) {
        return Ok(if relative.as_os_str().is_empty() {
            "/work".to_string()
        } else {
            format!(
                "/work/{}",
                relative
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/")
            )
        });
    }
    let relative = host_path
        .strip_prefix(vm_tmp_root(vm)?)
        .context("path is not inside VM workspace")?;
    Ok(if relative.as_os_str().is_empty() {
        "/tmp".to_string()
    } else {
        format!(
            "/tmp/{}",
            relative
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/")
        )
    })
}

fn paths_match(source: &Path, dest: &Path) -> bool {
    if lexical_normalize(source) == lexical_normalize(dest) {
        return true;
    }

    match (source.canonicalize(), dest.canonicalize()) {
        (Ok(source_canonical), Ok(dest_canonical)) => source_canonical == dest_canonical,
        _ => false,
    }
}

pub(crate) fn copy_path(source: &Path, dest: &Path) -> Result<()> {
    if source.exists() && paths_match(source, dest) {
        return Ok(());
    }

    if source.is_dir() {
        fs::create_dir_all(dest)?;
        for entry in WalkDir::new(source)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .skip(1)
        {
            let relative = entry.path().strip_prefix(source)?;
            let target = dest.join(relative);
            if entry.file_type().is_dir() {
                fs::create_dir_all(&target)?;
            } else {
                fs::create_dir_all(target.parent().context("copied file missing parent")?)?;
                fs::copy(entry.path(), target)?;
            }
        }
    } else {
        fs::create_dir_all(dest.parent().context("copy destination missing parent")?)?;
        fs::copy(source, dest)?;
    }
    Ok(())
}

pub(crate) fn copy_path_preserving_conflicts(
    source: &Path,
    dest: &Path,
    legacy_label: &str,
) -> Result<()> {
    if source.exists() && paths_match(source, dest) {
        return Ok(());
    }

    let conflict_root = dest.join(".legacy-agent-vm").join(legacy_label);
    if source.is_dir() {
        fs::create_dir_all(dest)?;
        for entry in WalkDir::new(source)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .skip(1)
        {
            let relative = entry.path().strip_prefix(source)?;
            let target = dest.join(relative);
            let conflict_target = conflict_root.join(relative);
            if entry.file_type().is_dir() {
                fs::create_dir_all(&target)?;
            } else if target.exists() {
                fs::create_dir_all(
                    conflict_target
                        .parent()
                        .context("legacy conflict file missing parent")?,
                )?;
                fs::copy(entry.path(), conflict_target)?;
            } else {
                fs::create_dir_all(target.parent().context("copied file missing parent")?)?;
                fs::copy(entry.path(), target)?;
            }
        }
    } else if dest.exists() {
        fs::create_dir_all(&conflict_root)?;
        let file_name = source
            .file_name()
            .context("legacy source file missing filename")?;
        fs::copy(source, conflict_root.join(file_name))?;
    } else {
        fs::create_dir_all(dest.parent().context("copy destination missing parent")?)?;
        fs::copy(source, dest)?;
    }
    Ok(())
}

pub(crate) fn read_utf8_file(vm: &VmInfo, path: &str) -> Result<String> {
    let bytes = fs::read(vm_host_path(vm, path)?)?;
    String::from_utf8(bytes).map_err(|_| anyhow!("file is not valid UTF-8"))
}

pub(crate) fn edit_file_impl(
    vm: &VmInfo,
    file_path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Result<usize> {
    if old_string.is_empty() {
        bail!("old_string must not be empty");
    }
    if !has_file_been_read(vm.vm_id.as_str(), file_path)? {
        bail!("File must be read before editing");
    }
    let host_path = vm_host_path(vm, file_path)?;
    let original = fs::read_to_string(&host_path)
        .with_context(|| format!("failed to read {}", host_path.display()))?;
    let matches = original.matches(old_string).count();
    if matches == 0 {
        bail!("old_string not found in file");
    }
    if !replace_all && matches != 1 {
        bail!("old_string must appear exactly once unless replace_all is true");
    }
    let updated = if replace_all {
        original.replace(old_string, new_string)
    } else {
        original.replacen(old_string, new_string, 1)
    };
    fs::write(host_path, updated)?;
    Ok(if replace_all { matches } else { 1 })
}

pub(crate) fn create_batch_file(vm: &VmInfo, file: &Value) -> Result<String> {
    let object = file.as_object().context("file entry must be an object")?;
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .context("file path is required")?;
    let content = object
        .get("content")
        .and_then(Value::as_str)
        .context("file content is required")?;
    let host_path = vm_host_path(vm, path)?;
    fs::create_dir_all(host_path.parent().context("batch file missing parent")?)?;
    fs::write(&host_path, content)?;
    vm_path_string(vm, &host_path)
}

pub(crate) async fn create_batch_file_async(vm: &VmInfo, file: &Value) -> Result<String> {
    if fake_docker_enabled() {
        return create_batch_file(vm, file);
    }
    let object = file.as_object().context("file entry must be an object")?;
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .context("file path is required")?;
    let content = object
        .get("content")
        .and_then(Value::as_str)
        .context("file content is required")?;
    vm_write_bytes(vm, path, content.as_bytes(), false).await
}

pub(crate) async fn edit_file_impl_async(
    vm: &VmInfo,
    file_path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Result<usize> {
    if fake_docker_enabled() {
        return edit_file_impl(vm, file_path, old_string, new_string, replace_all);
    }
    if old_string.is_empty() {
        bail!("old_string must not be empty");
    }
    if !has_file_been_read(vm.vm_id.as_str(), file_path)? {
        bail!("File must be read before editing");
    }
    let (_vm_path, bytes) = vm_read_bytes(vm, file_path).await?;
    let original = String::from_utf8(bytes).map_err(|_| anyhow!("file is not valid UTF-8"))?;
    let matches = original.matches(old_string).count();
    if matches == 0 {
        bail!("old_string not found in file");
    }
    if !replace_all && matches != 1 {
        bail!("old_string must appear exactly once unless replace_all is true");
    }
    let updated = if replace_all {
        original.replace(old_string, new_string)
    } else {
        original.replacen(old_string, new_string, 1)
    };
    vm_write_bytes(vm, file_path, updated.as_bytes(), false).await?;
    Ok(if replace_all { matches } else { 1 })
}

pub(crate) async fn list_vm_directory(
    vm: &VmInfo,
    directory: &str,
    recursive: bool,
) -> Result<(Vec<String>, Vec<String>)> {
    if fake_docker_enabled() {
        let root = vm_host_path(vm, directory)?;
        if !root.is_dir() {
            bail!("Directory not found: {directory}");
        }
        let mut files = Vec::new();
        let mut directories = Vec::new();
        let iterator = if recursive {
            WalkDir::new(&root)
        } else {
            WalkDir::new(&root).max_depth(1)
        };
        for entry in iterator.into_iter().filter_map(|entry| entry.ok()).skip(1) {
            let path = entry.path();
            if entry.file_type().is_dir() {
                directories.push(
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or_default()
                        .to_string(),
                );
            } else {
                files.push(
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or_default()
                        .to_string(),
                );
            }
        }
        return Ok((files, directories));
    }
    let response = vm_python_json(
        vm,
        VM_FILE_SCRIPT,
        json!({"op": "list", "path": validate_container_vm_path(directory)?, "recursive": recursive}),
    )
    .await?;
    if !response
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        bail!("Directory not found: {directory}");
    }
    let files = response
        .get("files")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let directories = response
        .get("directories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    Ok((files, directories))
}

pub(crate) async fn unzip_file_in_vm(
    vm: &VmInfo,
    zip_path: &str,
    dest_path: &str,
    strip_components: usize,
) -> Result<Value> {
    if fake_docker_enabled() {
        let zip_host_path = vm_host_path(vm, zip_path)?;
        let dest_host_path = vm_host_path(vm, dest_path)?;
        let normalized_dest = normalize_vm_path(dest_path);
        let workspace_root = if normalized_dest == "/tmp" || normalized_dest.starts_with("/tmp/") {
            vm_tmp_root(vm)?
        } else {
            resolve_local_work_bind_source(vm)?
        };
        let summary = unzip_into(
            &zip_host_path,
            &workspace_root,
            &dest_host_path,
            strip_components,
        )?;
        return Ok(json!({
            "success": true,
            "zip_path": vm_path_string(vm, &zip_host_path)?,
            "dest_path": vm_path_string(vm, &dest_host_path)?,
            "files_extracted": summary.files_extracted,
            "top_level_files": summary.top_level_files,
            "top_level_directories": summary.top_level_directories,
        }));
    }
    let response = vm_python_json(
        vm,
        VM_FILE_SCRIPT,
        json!({
            "op": "unzip",
            "zip_path": validate_container_vm_path(zip_path)?,
            "dest_path": validate_container_vm_path(dest_path)?,
            "strip_components": strip_components,
        }),
    )
    .await?;
    if response.get("success").and_then(Value::as_bool) == Some(false)
        && response.get("error_code").and_then(Value::as_str)
            == Some(UNSAFE_ARCHIVE_PATH_ERROR_CODE)
    {
        let member = response
            .get("unsafe_member")
            .and_then(Value::as_str)
            .unwrap_or("<unknown>");
        return Err(UnsafeArchivePathError::from_preview(member).into());
    }
    Ok(response)
}

pub(crate) async fn find_files_in_vm(
    vm: &VmInfo,
    pattern: &str,
    search_root: &str,
    max_results: usize,
) -> Result<Value> {
    if fake_docker_enabled() {
        let glob = Pattern::new(pattern)?;
        let root = vm_host_path(vm, search_root)?;
        let mut matches = WalkDir::new(&root)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
            .filter(|entry| glob.matches_path(entry.path()))
            .map(|entry| entry.path().to_path_buf())
            .collect::<Vec<_>>();
        matches.sort_by_key(|path| {
            path.metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH)
        });
        matches.reverse();
        let truncated = matches.len() > max_results;
        let files = matches
            .into_iter()
            .take(max_results)
            .filter_map(|path| vm_path_string(vm, &path).ok())
            .collect::<Vec<_>>();
        return Ok(json!({"files": files.clone(), "count": files.len(), "truncated": truncated}));
    }
    vm_python_json(
        vm,
        VM_FILE_SCRIPT,
        json!({
            "op": "find",
            "pattern": pattern,
            "path": validate_container_vm_path(search_root)?,
            "max_results": max_results,
        }),
    )
    .await
}

pub(crate) async fn grep_in_vm(
    vm: &VmInfo,
    pattern: &str,
    search_root: &str,
    file_pattern: Option<&str>,
    max_results: usize,
    case_insensitive: bool,
    output_mode: &str,
) -> Result<Value> {
    if fake_docker_enabled() {
        return Ok(Value::Null);
    }
    vm_python_json(
        vm,
        VM_FILE_SCRIPT,
        json!({
            "op": "grep",
            "pattern": pattern,
            "path": validate_container_vm_path(search_root)?,
            "file_pattern": file_pattern,
            "max_results": max_results,
            "case_insensitive": case_insensitive,
            "output_mode": output_mode,
        }),
    )
    .await
}

fn workspace_file_path(chat_id: &str, file_path: &str) -> Result<PathBuf> {
    let relative = sanitize_workspace_relative(file_path, false)?;
    reject_private_workspace_root(chat_id, &relative)?;
    let root = container_chat_workspace_root(chat_id)?;
    let path = root.join(&relative);
    ensure_within(&root, &path)?;
    Ok(path)
}

pub(crate) fn not_found_workspace_file_payload(chat_id: &str, file_path: &str) -> Result<Value> {
    success_text(json!({
        "success": false,
        "error": "File does not exist",
        "file_path": file_path,
        "chat_id": chat_id,
        "hint": "Use Agent VM file tools with the same vm_id to inspect /work.",
    }))
}

pub(crate) fn directory_workspace_file_payload(file_path: &str) -> Result<Value> {
    success_text(json!({
        "success": false,
        "error": "Path is a directory, not a file",
        "file_path": file_path,
        "hint": "Use Agent VM file tools with the same vm_id to inspect /work.",
    }))
}

fn workspace_file_info(chat_id: &str, file_path: &str) -> Result<Option<WorkspaceFileInfo>> {
    let path = workspace_file_path(chat_id, file_path)?;
    if !path.exists() {
        return Ok(None);
    }
    if path.is_dir() {
        bail!("workspace path is a directory");
    }
    let metadata = path.metadata()?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let mime_type = MimeGuess::from_path(&path).first_raw().map(str::to_string);
    let is_inline_image = mime_type
        .as_deref()
        .map(|mime| mime.starts_with("image/"))
        .unwrap_or(false)
        && metadata.len() <= MAX_INLINE_IMAGE_SIZE;
    Ok(Some(WorkspaceFileInfo {
        file_name,
        file_path: file_path.to_string(),
        file_size: metadata.len(),
        file_size_formatted: format_bytes(metadata.len()),
        chat_id: chat_id.to_string(),
        download_url: workspace_download_url(chat_id, file_path)?,
        is_inline_image,
    }))
}

pub(crate) fn workspace_file_payload(
    vm: &VmInfo,
    file_path: &str,
    message: &str,
    vm_path: Option<&str>,
) -> Result<Value> {
    let info = match workspace_file_info(&vm.chat_id, file_path) {
        Ok(Some(info)) => info,
        Ok(None) => return not_found_workspace_file_payload(&vm.chat_id, file_path),
        Err(error) if error.to_string() == "workspace path is a directory" => {
            return directory_workspace_file_payload(file_path)
        }
        Err(error) => return Err(error),
    };
    let Some(vm_path) = vm_path else {
        return workspace_link_payload(&vm.chat_id, &vm.vm_id, file_path);
    };
    success_text(json!({
        "success": true,
        "vm_path": vm_path,
        "workspace_path": file_path,
        "file_name": info.file_name,
        "file_size": info.file_size,
        "file_size_formatted": info.file_size_formatted,
        "chat_id": info.chat_id,
        "download_url": info.download_url,
        "is_image": info.is_inline_image,
        "visual_analysis_requires_image_input": info.is_inline_image,
        "markdown_link": format!("[Download {}]({})", info.file_name, info.download_url),
        "markdown_image": Value::Null,
        "message": if info.is_inline_image {
            Value::String(format!(
                "{message} The image file is available as a download link. To show it to the user, call agent_vm_display_files. To inspect it with this model, call agent_vm_request_images; markdown links alone do not provide pixels."
            ))
        } else {
            Value::String(format!(
                "{message} Include the markdown_link in your response so the user can download the file."
            ))
        },
    }))
}

fn workspace_file_info_from_vm_stat(
    chat_id: &str,
    file_path: &str,
    stat: &Value,
) -> Result<WorkspaceFileInfo> {
    let relative = sanitize_workspace_relative(file_path, false)?;
    reject_private_workspace_root(chat_id, &relative)?;
    let file_name = Path::new(&relative)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&relative)
        .to_string();
    let file_size = stat.get("size").and_then(Value::as_u64).unwrap_or(0);
    let mime_type = MimeGuess::from_path(&relative)
        .first_raw()
        .map(str::to_string);
    let is_inline_image = mime_type
        .as_deref()
        .map(|mime| mime.starts_with("image/"))
        .unwrap_or(false)
        && file_size <= MAX_INLINE_IMAGE_SIZE;
    Ok(WorkspaceFileInfo {
        file_name,
        file_path: relative.clone(),
        file_size,
        file_size_formatted: format_bytes(file_size),
        chat_id: chat_id.to_string(),
        download_url: workspace_download_url(chat_id, &relative)?,
        is_inline_image,
    })
}

fn workspace_link_payload_from_info(vm_id: &str, info: WorkspaceFileInfo) -> Result<Value> {
    let payload = json!({
        "success": true,
        "file_name": info.file_name,
        "file_path": info.file_path,
        "file_size": info.file_size,
        "file_size_formatted": info.file_size_formatted,
        "chat_id": info.chat_id,
        "vm_id": vm_id,
        "download_url": info.download_url,
        "markdown_link": format!("[Download {}]({})", info.file_name, info.download_url),
        "is_image": info.is_inline_image,
        "visual_analysis_requires_image_input": info.is_inline_image,
        "message": if info.is_inline_image {
            "File link ready. This tool only creates a link and does not display image previews. Call agent_vm_display_files to show the file in chat, or agent_vm_request_images to attach image pixels to the next model request."
        } else {
            "File download link ready. Include the markdown_link in your response so the user can download the file."
        },
    });
    Ok(json!({
        "content": [
            {
                "type": "text",
                "text": serde_json::to_string_pretty(&payload)?,
            }
        ],
        "structuredContent": Value::Null,
        "isError": false,
    }))
}

pub(crate) fn workspace_link_payload_from_stat(
    chat_id: &str,
    vm_id: &str,
    file_path: &str,
    stat: &Value,
) -> Result<Value> {
    workspace_link_payload_from_info(
        vm_id,
        workspace_file_info_from_vm_stat(chat_id, file_path, stat)?,
    )
}

pub(crate) fn workspace_link_payload(chat_id: &str, vm_id: &str, file_path: &str) -> Result<Value> {
    let info = match workspace_file_info(chat_id, file_path) {
        Ok(Some(info)) => info,
        Ok(None) => return not_found_workspace_file_payload(chat_id, file_path),
        Err(error) if error.to_string() == "workspace path is a directory" => {
            return directory_workspace_file_payload(file_path)
        }
        Err(error) => return Err(error),
    };
    workspace_link_payload_from_info(vm_id, info)
}

#[derive(Debug)]
pub(crate) struct UnzipSummary {
    pub(crate) files_extracted: usize,
    pub(crate) top_level_files: Vec<String>,
    pub(crate) top_level_directories: Vec<String>,
}

#[derive(Debug)]
struct ArchiveMemberPlan {
    index: usize,
    parts: Vec<OsString>,
    is_directory: bool,
    member_name: String,
}

fn read_raw_central_directory_names(
    zip_path: &Path,
    central_directory_start: u64,
) -> Result<Vec<Vec<u8>>> {
    const CENTRAL_DIRECTORY_HEADER: [u8; 4] = [0x50, 0x4b, 0x01, 0x02];
    const CENTRAL_DIRECTORY_END_SIGNATURES: [[u8; 4]; 4] = [
        [0x50, 0x4b, 0x05, 0x05],
        [0x50, 0x4b, 0x05, 0x06],
        [0x50, 0x4b, 0x06, 0x06],
        [0x50, 0x4b, 0x06, 0x07],
    ];

    let mut file = fs::File::open(zip_path)?;
    file.seek(SeekFrom::Start(central_directory_start))?;
    let mut names = Vec::new();
    loop {
        let mut signature = [0_u8; 4];
        file.read_exact(&mut signature)
            .context("ZIP central directory ended unexpectedly")?;
        if signature != CENTRAL_DIRECTORY_HEADER {
            if CENTRAL_DIRECTORY_END_SIGNATURES.contains(&signature) {
                break;
            }
            bail!("ZIP central directory contains an invalid record");
        }

        let mut fixed = [0_u8; 42];
        file.read_exact(&mut fixed)
            .context("ZIP central directory record is truncated")?;
        let name_length = u16::from_le_bytes([fixed[24], fixed[25]]) as usize;
        let extra_length = u16::from_le_bytes([fixed[26], fixed[27]]) as u64;
        let comment_length = u16::from_le_bytes([fixed[28], fixed[29]]) as u64;
        let mut name = vec![0_u8; name_length];
        file.read_exact(&mut name)
            .context("ZIP central directory member name is truncated")?;
        file.seek(SeekFrom::Current(
            (extra_length + comment_length)
                .try_into()
                .context("ZIP central directory record is too large")?,
        ))?;
        names.push(name);
    }
    Ok(names)
}

fn preflight_archive(
    zip_path: &Path,
    archive: &mut ZipArchive<fs::File>,
    strip_components: usize,
) -> Result<Vec<ArchiveMemberPlan>> {
    let raw_names = read_raw_central_directory_names(zip_path, archive.central_directory_start())?;
    for raw_name in &raw_names {
        validate_archive_name_bytes(raw_name, raw_name.ends_with(b"/"))?;
    }

    if raw_names.len() != archive.len() {
        let member = raw_names
            .last()
            .map(Vec::as_slice)
            .unwrap_or(b"<duplicate archive member>");
        return Err(UnsafeArchivePathError::from_bytes(member).into());
    }

    let mut effective_names = HashSet::new();
    let mut plans = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        let member_name = entry.name().to_string();
        let is_directory = entry.is_dir();
        let parts = validated_effective_archive_parts(&member_name, is_directory)?;
        if !effective_names.insert(member_name.clone()) {
            return Err(UnsafeArchivePathError::new(&member_name).into());
        }
        drop(entry);

        let retained = parts.into_iter().skip(strip_components).collect::<Vec<_>>();
        if retained.is_empty() {
            continue;
        }
        plans.push(ArchiveMemberPlan {
            index,
            parts: retained,
            is_directory,
            member_name,
        });
    }
    Ok(plans)
}

fn relative_destination_parts(workspace_root: &Path, dest_path: &Path) -> Result<Vec<OsString>> {
    let normalized_root = lexical_normalize(workspace_root);
    let normalized_dest = lexical_normalize(dest_path);
    let relative = normalized_dest
        .strip_prefix(&normalized_root)
        .context("unzip destination escapes VM workspace")?;
    relative
        .components()
        .map(|component| match component {
            std::path::Component::Normal(part) => Ok(part.to_os_string()),
            _ => bail!("unzip destination contains an unsafe component"),
        })
        .collect()
}

#[cfg(unix)]
fn unsafe_member_io_error(error: Errno, member: Option<&str>) -> anyhow::Error {
    if member.is_some() && matches!(error, Errno::LOOP | Errno::NOTDIR) {
        return UnsafeArchivePathError::new(member.unwrap_or_default()).into();
    }
    error.into()
}

#[cfg(unix)]
fn open_directory_at(
    parent: &OwnedFd,
    component: &OsStr,
    member: Option<&str>,
    create: bool,
) -> Result<OwnedFd> {
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    match openat(parent, component, flags, Mode::empty()) {
        Ok(fd) => Ok(fd),
        Err(Errno::NOENT) if create => {
            match mkdirat(parent, component, Mode::from_raw_mode(0o755)) {
                Ok(()) | Err(Errno::EXIST) => {}
                Err(error) => return Err(unsafe_member_io_error(error, member)),
            }
            openat(parent, component, flags, Mode::empty())
                .map_err(|error| unsafe_member_io_error(error, member))
        }
        Err(error) => Err(unsafe_member_io_error(error, member)),
    }
}

#[cfg(unix)]
fn open_directory_path(
    start: &OwnedFd,
    parts: &[OsString],
    member: Option<&str>,
    create: bool,
) -> Result<OwnedFd> {
    let mut current = dup(start)?;
    for component in parts {
        current = open_directory_at(&current, component, member, create)?;
    }
    Ok(current)
}

#[cfg(unix)]
fn verify_existing_member_path(dest: &OwnedFd, plan: &ArchiveMemberPlan) -> Result<()> {
    let mut current = dup(dest)?;
    for (index, component) in plan.parts.iter().enumerate() {
        let metadata = match statat(&current, component, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(metadata) => metadata,
            Err(Errno::NOENT) => return Ok(()),
            Err(error) => return Err(unsafe_member_io_error(error, Some(&plan.member_name))),
        };
        let file_type = FileType::from_raw_mode(metadata.st_mode);
        if file_type.is_symlink() {
            return Err(UnsafeArchivePathError::new(&plan.member_name).into());
        }

        let is_last = index == plan.parts.len() - 1;
        if is_last {
            if plan.is_directory && !file_type.is_dir() {
                bail!("archive directory conflicts with an existing non-directory");
            }
            if !plan.is_directory && file_type.is_dir() {
                bail!("archive file conflicts with an existing directory");
            }
            return Ok(());
        }
        if !file_type.is_dir() {
            bail!("archive member parent conflicts with an existing non-directory");
        }
        current = open_directory_at(&current, component, Some(&plan.member_name), false)?;
    }
    Ok(())
}

#[cfg(unix)]
fn summarize_directory_path(dest_path: &Path) -> Result<(Vec<String>, Vec<String>)> {
    let mut files = Vec::new();
    let mut directories = Vec::new();
    for entry in fs::read_dir(dest_path)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.file_type()?.is_dir() {
            directories.push(name);
        } else {
            files.push(name);
        }
    }
    files.sort();
    directories.sort();
    Ok((files, directories))
}

#[cfg(unix)]
fn extract_preflighted_archive(
    archive: &mut ZipArchive<fs::File>,
    canonical_root: &Path,
    dest_path: &Path,
    dest_parts: &[OsString],
    plans: &[ArchiveMemberPlan],
) -> Result<UnzipSummary> {
    let root = open(
        canonical_root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let dest = open_directory_path(&root, dest_parts, None, true)?;

    for plan in plans {
        verify_existing_member_path(&dest, plan)?;
    }

    let mut files_extracted = 0;
    for plan in plans {
        if plan.is_directory {
            drop(open_directory_path(
                &dest,
                &plan.parts,
                Some(&plan.member_name),
                true,
            )?);
            continue;
        }

        let (file_name, parent_parts) = plan
            .parts
            .split_last()
            .context("archive file is missing its name")?;
        let parent = open_directory_path(&dest, parent_parts, Some(&plan.member_name), true)?;
        let output_fd = openat(
            &parent,
            file_name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::TRUNC | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o666),
        )
        .map_err(|error| unsafe_member_io_error(error, Some(&plan.member_name)))?;
        let mut output = fs::File::from(output_fd);
        let mut entry = archive.by_index(plan.index)?;
        std::io::copy(&mut entry, &mut output)?;
        files_extracted += 1;
    }

    let (top_level_files, top_level_directories) = summarize_directory_path(dest_path)?;
    Ok(UnzipSummary {
        files_extracted,
        top_level_files,
        top_level_directories,
    })
}

pub(crate) fn unzip_into(
    zip_path: &Path,
    workspace_root: &Path,
    dest_path: &Path,
    strip_components: usize,
) -> Result<UnzipSummary> {
    let file = fs::File::open(zip_path)?;
    let mut archive = ZipArchive::new(file)?;
    let plans = preflight_archive(zip_path, &mut archive, strip_components)?;
    let dest_parts = relative_destination_parts(workspace_root, dest_path)?;

    fs::create_dir_all(workspace_root)?;
    let canonical_root = workspace_root.canonicalize()?;
    #[cfg(unix)]
    {
        extract_preflighted_archive(
            &mut archive,
            &canonical_root,
            dest_path,
            &dest_parts,
            &plans,
        )
    }
    #[cfg(not(unix))]
    {
        let _ = (archive, canonical_root, dest_parts, plans);
        bail!("secure ZIP extraction is unsupported on this platform")
    }
}
