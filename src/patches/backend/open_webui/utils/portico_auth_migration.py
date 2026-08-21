from copy import deepcopy


def preserve_legacy_user_settings(legacy_user, human_user) -> bool:
    if legacy_user is None or human_user is None or not hasattr(human_user, "settings"):
        return False

    legacy_settings = getattr(legacy_user, "settings", None)
    if legacy_settings is None:
        return False

    human_user.settings = deepcopy(legacy_settings)
    return True
