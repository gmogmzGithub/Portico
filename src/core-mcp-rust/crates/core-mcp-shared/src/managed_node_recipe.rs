use std::fmt;

use serde_json::Value;

const PACKAGE_MANAGER_COMMANDS: &[&str] = &["npx", "npm", "pnpm", "yarn", "bunx"];
const PACKAGE_MANAGER_SUBCOMMANDS: &[&str] = &["exec", "x", "dlx"];
const FLAGS_WITH_VALUES: &[&str] = &[
    "--package",
    "-p",
    "--cache",
    "--registry",
    "--userconfig",
    "--globalconfig",
    "--script-shell",
];
const DISALLOWED_FLAGS: &[&str] = &[
    "--cache",
    "--registry",
    "--userconfig",
    "--globalconfig",
    "--script-shell",
];
const FLAGS_WITHOUT_VALUES: &[&str] = &["-y", "--yes", "--no", "--no-install", "--ignore-existing"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedNodeRecipe {
    pub command: String,
    pub args: Vec<String>,
    pub package_spec: String,
    pub package_name: String,
    pub requested_range: String,
    pub runtime_args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedNodeRecipeError {
    pub code: &'static str,
    pub message: String,
}

impl ManagedNodeRecipeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ManagedNodeRecipeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ManagedNodeRecipeError {}

pub fn is_package_manager_command(command: &str) -> bool {
    PACKAGE_MANAGER_COMMANDS.contains(&basename(command).as_str())
}

/// Parse the package-execution subset supported by PORTICO's managed Node runtime.
///
/// This function intentionally has no filesystem or process side effects so
/// fragment creation/update can dry-run the exact grammar used at startup.
pub fn parse_managed_node_recipe(
    command: &str,
    args: &[Value],
) -> Result<ManagedNodeRecipe, ManagedNodeRecipeError> {
    let command_name = basename(command);
    if !PACKAGE_MANAGER_COMMANDS.contains(&command_name.as_str()) {
        return Err(ManagedNodeRecipeError::new(
            "UNSUPPORTED_PACKAGE_MANAGER",
            format!("unsupported package manager command: {command}"),
        ));
    }
    let string_args: Vec<String> = args
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| value.to_string())
        })
        .collect();

    let mut cursor = 0usize;
    if matches!(command_name.as_str(), "pnpm" | "yarn" | "npm") {
        let Some(subcommand) = string_args.first() else {
            return Err(ManagedNodeRecipeError::new(
                if command_name == "npm" {
                    "UNSUPPORTED_NPM_SUBCOMMAND"
                } else {
                    "UNSUPPORTED_PACKAGE_MANAGER_SUBCOMMAND"
                },
                format!("{command_name} recipe must include a dlx/exec subcommand"),
            ));
        };
        if !PACKAGE_MANAGER_SUBCOMMANDS.contains(&subcommand.as_str()) {
            return Err(ManagedNodeRecipeError::new(
                if command_name == "npm" {
                    "UNSUPPORTED_NPM_SUBCOMMAND"
                } else {
                    "UNSUPPORTED_PACKAGE_MANAGER_SUBCOMMAND"
                },
                format!("{command_name} recipe must use dlx/exec, not {subcommand}"),
            ));
        }
        cursor = 1;
    }

    let mut package_spec: Option<String> = None;
    let mut runtime_args: Vec<String> = Vec::new();
    let mut package_seen = false;

    while cursor < string_args.len() {
        let arg = &string_args[cursor];
        if arg == "--" {
            runtime_args = string_args[cursor + 1..].to_vec();
            break;
        }
        if package_seen && package_spec.is_some() {
            runtime_args = string_args[cursor..].to_vec();
            break;
        }
        if DISALLOWED_FLAGS.contains(&arg.as_str()) {
            return Err(ManagedNodeRecipeError::new(
                "MANAGED_NODE_FLAG_NOT_ALLOWED",
                format!("package-manager flag {arg} is not allowed for managed MCP recipes"),
            ));
        }
        if let Some((flag, _value)) = arg.split_once('=') {
            if DISALLOWED_FLAGS.contains(&flag) {
                return Err(ManagedNodeRecipeError::new(
                    "MANAGED_NODE_FLAG_NOT_ALLOWED",
                    format!("package-manager flag {flag} is not allowed for managed MCP recipes"),
                ));
            }
        }
        if matches!(arg.as_str(), "--package" | "-p") {
            let Some(value) = string_args.get(cursor + 1) else {
                return Err(ManagedNodeRecipeError::new(
                    "MANAGED_NODE_FLAG_VALUE_MISSING",
                    format!("missing value for {arg}"),
                ));
            };
            package_spec = Some(value.clone());
            cursor += 2;
            continue;
        }
        if FLAGS_WITH_VALUES.contains(&arg.as_str()) {
            cursor += 2;
            continue;
        }
        if FLAGS_WITHOUT_VALUES.contains(&arg.as_str()) {
            cursor += 1;
            continue;
        }
        if arg.starts_with('-') && !arg.contains('=') {
            cursor += 1;
            continue;
        }
        if package_spec.is_none() {
            package_spec = Some(arg.clone());
            package_seen = true;
            cursor += 1;
            continue;
        }
        if package_seen {
            runtime_args = string_args[cursor..].to_vec();
        }
        break;
    }

    let Some(package_spec) = package_spec else {
        return Err(ManagedNodeRecipeError::new(
            "MANAGED_NODE_PACKAGE_MISSING",
            "package-manager recipe is missing a package spec for managed Node MCP",
        ));
    };
    if package_spec.starts_with('-') {
        return Err(ManagedNodeRecipeError::new(
            "INVALID_MANAGED_NODE_PACKAGE_SPEC",
            format!("invalid package spec: {package_spec}"),
        ));
    }
    let (package_name, requested_range) = split_package_spec(&package_spec)?;
    Ok(ManagedNodeRecipe {
        command: command_name,
        args: string_args,
        package_spec,
        package_name,
        requested_range,
        runtime_args,
    })
}

fn split_package_spec(package_spec: &str) -> Result<(String, String), ManagedNodeRecipeError> {
    let version_at = if package_spec.starts_with('@') {
        let Some(slash) = package_spec.find('/') else {
            return Err(ManagedNodeRecipeError::new(
                "INVALID_MANAGED_NODE_PACKAGE_SPEC",
                format!("invalid scoped package spec: {package_spec}"),
            ));
        };
        package_spec[slash + 1..]
            .find('@')
            .map(|offset| slash + 1 + offset)
    } else {
        package_spec.rfind('@')
    };

    let (name, requested_range) = if let Some(index) = version_at.filter(|index| *index > 0) {
        (
            package_spec[..index].to_string(),
            package_spec[index + 1..].to_string(),
        )
    } else {
        (package_spec.to_string(), "latest".to_string())
    };

    if name.is_empty() || name.chars().any(char::is_whitespace) {
        return Err(ManagedNodeRecipeError::new(
            "INVALID_MANAGED_NODE_PACKAGE_SPEC",
            format!("invalid package spec: {package_spec}"),
        ));
    }
    Ok((
        name,
        if requested_range.is_empty() {
            "latest".to_string()
        } else {
            requested_range
        },
    ))
}

fn basename(command: &str) -> String {
    command
        .replace('\\', "/")
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(command)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_supported_package_execution_recipes() {
        let npx = parse_managed_node_recipe(
            "npx",
            &[json!("-y"), json!("@scope/demo@1.2.3"), json!("--readonly")],
        )
        .unwrap();
        assert_eq!(npx.package_name, "@scope/demo");
        assert_eq!(npx.requested_range, "1.2.3");
        assert_eq!(npx.runtime_args, ["--readonly"]);

        let npm = parse_managed_node_recipe(
            "/usr/local/bin/npm",
            &[
                json!("exec"),
                json!("demo@latest"),
                json!("--"),
                json!("--stdio"),
            ],
        )
        .unwrap();
        assert_eq!(npm.command, "npm");
        assert_eq!(npm.package_name, "demo");
        assert_eq!(npm.runtime_args, ["--stdio"]);
    }

    #[test]
    fn rejects_npm_lifecycle_commands_with_stable_code() {
        for subcommand in ["start", "install", "run"] {
            let error = parse_managed_node_recipe("npm", &[json!(subcommand)]).unwrap_err();
            assert_eq!(error.code, "UNSUPPORTED_NPM_SUBCOMMAND");
            assert!(error.to_string().contains("must use dlx/exec"));
        }
    }

    #[test]
    fn rejects_assigned_package_manager_config_flags() {
        for flag in [
            "--registry=https://registry.npmjs.org",
            "--userconfig=/tmp/npmrc",
            "--script-shell=/bin/sh",
        ] {
            let error =
                parse_managed_node_recipe("npx", &[json!(flag), json!("demo")]).unwrap_err();
            assert_eq!(error.code, "MANAGED_NODE_FLAG_NOT_ALLOWED");
        }

        let error = parse_managed_node_recipe("npx", &[json!("--unknown=value")]).unwrap_err();
        assert_eq!(error.code, "INVALID_MANAGED_NODE_PACKAGE_SPEC");
    }
}
