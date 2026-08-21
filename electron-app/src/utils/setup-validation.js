// Validation utilities for guided setup
// Extracted from guided-setup.js

// Validate environment variable value
function validateEnvValue(value, fieldName = 'field') {
  const trimmedValue = value.trim();

  // Check for empty value
  if (!trimmedValue || trimmedValue.length === 0) {
    return { valid: false, error: `${fieldName} cannot be empty` };
  }

  // Check for spaces only
  if (trimmedValue.match(/^\s+$/)) {
    return { valid: false, error: `${fieldName} cannot contain only spaces` };
  }

  // Check for http:// or https:// prefix
  if (trimmedValue.startsWith('http://') || trimmedValue.startsWith('https://')) {
    return { valid: false, error: `${fieldName} cannot start with 'http://' or 'https://' - please remove the protocol prefix` };
  }

  // Check for curly braces and double quotes
  if (trimmedValue.includes('{') || trimmedValue.includes('}') || trimmedValue.includes('"')) {
    return { valid: false, error: `${fieldName} cannot contain curly braces ({ or }) or double quotes (")` };
  }

  return { valid: true, value: trimmedValue };
}

// Validate input field and show error if invalid
function validateInputField(input, fieldName) {
  const rawValue = input.value;
  const errorEl = input.parentElement?.querySelector('.input-error');
  const validation = validateEnvValue(rawValue, fieldName);

  if (!validation.valid) {
    if (errorEl) {
      errorEl.textContent = validation.error;
      errorEl.classList.add('visible');
    }
    input.classList.add('error');
    return { valid: false, error: validation.error };
  }

  // Clear error state
  if (errorEl) {
    errorEl.classList.remove('visible');
  }
  input.classList.remove('error');

  return { valid: true, value: validation.value };
}

// Validate against regex pattern
function validatePattern(value, pattern, errorMessage = 'Invalid format') {
  if (!pattern) {
    return { valid: true, value };
  }

  if (!new RegExp(pattern).test(value)) {
    return { valid: false, error: errorMessage };
  }

  return { valid: true, value };
}

// Validate all inputs in a container
function validateAllInputs(container, skipEmpty = false) {
  const inputs = container.querySelectorAll('.input-field:not([disabled])');
  const results = [];
  let hasErrors = false;

  inputs.forEach(input => {
    const varNameRaw = input.dataset.var;
    const fieldName = varNameRaw ? varNameRaw.split(',')[0] : 'field';
    const validation = validateInputField(input, fieldName);

    if (!validation.valid) {
      hasErrors = true;
    }

    results.push({
      element: input,
      varNameRaw,
      ...validation
    });
  });

  return {
    valid: !hasErrors,
    results
  };
}

// Export functions
module.exports = {
  validateEnvValue,
  validateInputField,
  validatePattern,
  validateAllInputs
};
