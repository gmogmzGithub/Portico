// The smoke runner intentionally discovers only *.unit.test.js files. Keep the
// packaged-build, runtime-secret, interrupted-update, and quit-provenance
// regressions in the canonical close-out gate while retaining their focused
// source-adjacent test files for broader runs.
require("../../scripts/prepare-cloudsmith-resource.test.js");
require("../config/runtime-secrets-config.test.js");
require("./quit-provenance.test.js");
require("./runtime-repair.test.js");
require("./security-regressions.test.js");
require("./setup-completion.test.js");
require("./setup-decision.test.js");
require("./update-loop-regressions.test.js");
require("./update-preparation.test.js");
