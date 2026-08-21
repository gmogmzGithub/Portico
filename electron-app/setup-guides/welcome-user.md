Welcome, let's get you going.

## Confirm Your Information

We've detected your username and pre-filled it below. Please confirm it's correct and provide your full name.

<user-input
  var="PORTICO_USER_ID"
  prompt="Your LDAP username:"
  validate="^[a-zA-Z0-9._-]+$"
  error="LDAP username can only contain letters, numbers, dots, underscores, and hyphens" />

<user-input
  var="PORTICO_USER_NAME"
  prompt="Your full name:"
  validate=".+"
  error="Full name cannot be empty" />

<success message="Welcome aboard! Let's continue with setup. 🎉" />
