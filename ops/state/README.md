# ops/state/ – runtime state directory
#
# This directory is a placeholder in the repository.
# The actual state file lives at /var/lib/home-automation/active_color
# (outside this repo so it survives git operations).
#
# The state file contains a single word – "blue" or "green" – indicating
# which gateway instance is currently receiving live traffic.
#
# It is managed exclusively by deploy/deploy.sh and deploy/rollback.sh.
# Do not edit it manually unless recovering from a partial failure.
