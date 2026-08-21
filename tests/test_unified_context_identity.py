import importlib.util
import pathlib
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "src" / "filters" / "unified_context.py"
SPEC = importlib.util.spec_from_file_location("unified_context_identity_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def build_filter(*, ldap="env-user", name="Environment User"):
    instance = MODULE.Filter.__new__(MODULE.Filter)
    instance.valves = MODULE.Filter.Valves()
    instance.ldap_id = ldap
    instance.user_name = name
    return instance


class UnifiedContextIdentityTests(unittest.TestCase):
    def test_authenticated_okta_identity_overrides_environment_fallbacks(self):
        context_filter = build_filter()
        result = context_filter._build_user_context(
            {
                "name": "Dionny Santiago",
                "email": "dsantiago@example.invalid",
                "username": "dsantiago@example.invalid",
                "oauth": {
                    "portico-okta": {
                        "claims": {
                            "name": "Dionny Santiago",
                            "given_name": "Dionny",
                            "email": "dsantiago@example.invalid",
                            "preferred_username": "dsantiago@example.invalid",
                        }
                    }
                },
            }
        )

        self.assertIn("Name: Dionny Santiago", result)
        self.assertIn("Given name: Dionny", result)
        self.assertIn("LDAP: dsantiago", result)
        self.assertIn("Email: dsantiago@example.invalid", result)
        self.assertNotIn("Environment User", result)
        self.assertNotIn("env-user", result)

    def test_environment_identity_is_used_only_when_authenticated_fields_are_missing(self):
        context_filter = build_filter(ldap="fallback", name="Fallback Name")
        result = context_filter._build_user_context({"oauth": {"portico-okta": {"claims": {}}}})

        self.assertIn("Name: Fallback Name", result)
        self.assertIn("LDAP: fallback", result)
        self.assertIn("Email: fallback@example.invalid", result)

    def test_service_identity_never_inherits_the_human_environment_fallback(self):
        context_filter = build_filter(ldap="dsantiago", name="Dionny Santiago")
        result = context_filter._build_user_context(
            {
                "name": "Portico Service",
                "email": "portico-service@localhost",
                "oauth": {"portico-service": {"sub": "portico-service"}},
            }
        )

        self.assertEqual(result, "")

    def test_identity_values_are_xml_escaped_and_json_oauth_is_supported(self):
        context_filter = build_filter(ldap=None, name=None)
        result = context_filter._build_user_context(
            {
                "name": "Dionny <Admin>",
                "email": "dsantiago@example.invalid",
                "oauth": '{"portico-okta":{"claims":{"preferred_username":"DOMAIN\\\\dsantiago"}}}',
            }
        )

        self.assertIn("Name: Dionny &lt;Admin&gt;", result)
        self.assertIn("LDAP: dsantiago", result)
        self.assertNotIn("<Admin>", result)


if __name__ == "__main__":
    unittest.main()
