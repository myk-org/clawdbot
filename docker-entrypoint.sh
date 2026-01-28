#!/bin/bash
set -e

# Handle Docker socket GID dynamically at runtime
# The Docker socket's GID varies between hosts, so we detect it at container startup
if [ -S /var/run/docker.sock ]; then
  DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)

  # Check if a group with this GID already exists
  EXISTING_GROUP=$(getent group "$DOCKER_GID" | cut -d: -f1 || true)

  if [ -n "$EXISTING_GROUP" ]; then
    # Add node user to the existing group
    usermod -aG "$EXISTING_GROUP" node
  else
    # Create docker group with the socket's GID, or modify existing docker group
    if getent group docker >/dev/null 2>&1; then
      groupmod -g "$DOCKER_GID" docker
    else
      groupadd -g "$DOCKER_GID" docker
    fi
    usermod -aG docker node
  fi
fi

# Create wacli log directory with proper ownership
mkdir -p /home/node/.wacli
chown node:node /home/node/.wacli

# Start wacli sync in the background as the node user
su - node -c "/home/linuxbrew/.linuxbrew/bin/wacli sync --follow > /home/node/.wacli/sync.log 2>&1 &"

# Drop privileges and execute the command as node user
exec sudo -u node -E "$@"
