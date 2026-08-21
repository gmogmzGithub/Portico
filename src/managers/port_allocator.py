"""
Port Allocator for Artifacts System

Manages dynamic port allocation for artifact containers that need to expose
ports to the host machine. Uses Redis for tracking allocated ports.

Port Range: 10000-19999 (10,000 available ports)
Binding: Localhost-only (127.0.0.1) for security

Usage:
    allocator = get_port_allocator()
    port = allocator.allocate_port(artifact_id="abc-123")
    # ... use port ...
    allocator.release_port(port)
"""

import os
import logging
import socket
import random
from typing import Optional, Dict, List

try:
    import redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False

logger = logging.getLogger(__name__)

# Prefix for all artifacts-related logging
LOG_PREFIX = "[Artifacts]"


class PortAllocator:
    """
    Manages dynamic port allocation for artifact containers.

    Ports are allocated from a configurable range and tracked in Redis.
    All ports are bound to localhost only for security.

    Supports two allocation modes:
    1. Per-artifact allocation (legacy): artifact_id -> single port
    2. Per-VM allocation (new): vm_id -> multiple ports for server pool
    """

    PORT_RANGE_START = 10000
    PORT_RANGE_END = 19999

    # Legacy keys (per-artifact allocation)
    REDIS_KEY_ALLOCATED = "artifact_ports:allocated"  # Hash: port -> artifact_id
    REDIS_KEY_BY_ARTIFACT = "artifact_ports:by_artifact"  # Hash: artifact_id -> port

    # New keys (per-VM allocation for server pools)
    REDIS_KEY_VM_PORTS = "vm_ports:"  # Prefix: vm_id -> Set of allocated ports
    REDIS_KEY_PORT_TO_VM = "artifact_ports:by_vm"  # Hash: port -> vm_id
    REDIS_KEY_EVICTED = "artifact_ports:evicted"  # Set: evicted ports (never reuse)

    def __init__(self, redis_client=None):
        """
        Initialize the PortAllocator.

        Args:
            redis_client: Redis client for port tracking persistence
        """
        self.redis_client = redis_client
        if self.redis_client is None and REDIS_AVAILABLE:
            try:
                self.redis_client = redis.Redis(
                    host=os.environ.get("REDIS_HOST", "redis"),
                    port=int(os.environ.get("REDIS_PORT", 6379)),
                    db=0,
                    decode_responses=True,
                    socket_connect_timeout=5,
                )
                self.redis_client.ping()
                logger.info(f"{LOG_PREFIX} PortAllocator connected to Redis")
            except Exception as e:
                logger.warning(f"{LOG_PREFIX} PortAllocator could not connect to Redis: {e}")
                self.redis_client = None

        # In-memory fallback if Redis unavailable
        self._local_allocated: Dict[int, str] = {}  # port -> artifact_id
        self._local_by_artifact: Dict[str, int] = {}  # artifact_id -> port

        # New: per-VM allocation tracking
        self._local_vm_ports: Dict[str, set] = {}  # vm_id -> set of ports
        self._local_port_to_vm: Dict[int, str] = {}  # port -> vm_id
        self._local_evicted: set = set()  # evicted ports (never reuse)

    def _is_port_in_use(self, port: int) -> bool:
        """
        Check if a port is currently in use on the system.

        Args:
            port: Port number to check

        Returns:
            True if port is in use, False otherwise
        """
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(1)
                result = s.connect_ex(('127.0.0.1', port))
                return result == 0  # 0 means connection successful = port in use
        except Exception:
            return False  # Assume available on error

    def _get_allocated_ports(self) -> Dict[int, str]:
        """Get all allocated ports from Redis or local storage."""
        if self.redis_client:
            try:
                allocated = self.redis_client.hgetall(self.REDIS_KEY_ALLOCATED)
                return {int(k): v for k, v in allocated.items()}
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to get allocated ports from Redis: {e}")
        return self._local_allocated.copy()

    def allocate_port(self, artifact_id: str) -> Optional[int]:
        """
        Allocate an available port for an artifact.

        If the artifact already has a port allocated, returns that port.
        Otherwise finds an available port from the pool.

        Args:
            artifact_id: Unique identifier for the artifact

        Returns:
            Allocated port number, or None if no ports available
        """
        # Check if artifact already has a port
        existing_port = self.get_port_for_artifact(artifact_id)
        if existing_port:
            logger.info(f"{LOG_PREFIX} Artifact {artifact_id} already has port {existing_port}")
            return existing_port

        # Get currently allocated ports
        allocated = self._get_allocated_ports()
        allocated_set = set(allocated.keys())

        # Find available port - randomize starting point for better distribution
        available_range = list(range(self.PORT_RANGE_START, self.PORT_RANGE_END + 1))
        random.shuffle(available_range)

        for port in available_range:
            if port not in allocated_set and not self._is_port_in_use(port):
                # Found available port - allocate it
                if self._store_allocation(port, artifact_id):
                    logger.info(f"{LOG_PREFIX} Allocated port {port} for artifact {artifact_id}")
                    return port

        logger.error(f"{LOG_PREFIX} No available ports in pool")
        return None

    def allocate_specific_port(self, artifact_id: str, port: int) -> bool:
        """
        Try to allocate a specific port for an artifact.

        Useful when restoring an artifact that was using a specific port.

        Args:
            artifact_id: Unique identifier for the artifact
            port: Specific port to allocate

        Returns:
            True if port was allocated, False if unavailable
        """
        if port < self.PORT_RANGE_START or port > self.PORT_RANGE_END:
            logger.error(f"{LOG_PREFIX} Port {port} is outside allowed range")
            return False

        # Check if port is already allocated
        allocated = self._get_allocated_ports()
        if port in allocated:
            if allocated[port] == artifact_id:
                return True  # Already allocated to this artifact
            logger.error(f"{LOG_PREFIX} Port {port} already allocated to {allocated[port]}")
            return False

        # Check if port is in use by another process
        if self._is_port_in_use(port):
            logger.error(f"{LOG_PREFIX} Port {port} is in use by another process")
            return False

        # Allocate the port
        if self._store_allocation(port, artifact_id):
            logger.info(f"{LOG_PREFIX} Allocated specific port {port} for artifact {artifact_id}")
            return True
        return False

    def _store_allocation(self, port: int, artifact_id: str) -> bool:
        """Store port allocation in Redis or local storage."""
        if self.redis_client:
            try:
                pipe = self.redis_client.pipeline()
                pipe.hset(self.REDIS_KEY_ALLOCATED, str(port), artifact_id)
                pipe.hset(self.REDIS_KEY_BY_ARTIFACT, artifact_id, str(port))
                pipe.execute()
                return True
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to store port allocation in Redis: {e}")
                return False
        else:
            self._local_allocated[port] = artifact_id
            self._local_by_artifact[artifact_id] = port
            return True

    def release_port(self, port: int) -> bool:
        """
        Release a port back to the pool.

        Args:
            port: Port number to release

        Returns:
            True if port was released, False otherwise
        """
        if self.redis_client:
            try:
                # Get artifact_id for this port first
                artifact_id = self.redis_client.hget(self.REDIS_KEY_ALLOCATED, str(port))

                pipe = self.redis_client.pipeline()
                pipe.hdel(self.REDIS_KEY_ALLOCATED, str(port))
                if artifact_id:
                    pipe.hdel(self.REDIS_KEY_BY_ARTIFACT, artifact_id)
                pipe.execute()

                logger.info(f"{LOG_PREFIX} Released port {port}")
                return True
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to release port from Redis: {e}")
                return False
        else:
            if port in self._local_allocated:
                artifact_id = self._local_allocated.pop(port)
                self._local_by_artifact.pop(artifact_id, None)
                logger.info(f"{LOG_PREFIX} Released port {port}")
                return True
            return False

    def release_port_for_artifact(self, artifact_id: str) -> bool:
        """
        Release the port allocated to a specific artifact.

        Args:
            artifact_id: Artifact identifier

        Returns:
            True if port was released, False if no port was allocated
        """
        port = self.get_port_for_artifact(artifact_id)
        if port:
            return self.release_port(port)
        return False

    def get_port_for_artifact(self, artifact_id: str) -> Optional[int]:
        """
        Get the allocated port for an artifact.

        Args:
            artifact_id: Artifact identifier

        Returns:
            Port number if allocated, None otherwise
        """
        if self.redis_client:
            try:
                port_str = self.redis_client.hget(self.REDIS_KEY_BY_ARTIFACT, artifact_id)
                if port_str:
                    return int(port_str)
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to get port for artifact from Redis: {e}")
        else:
            return self._local_by_artifact.get(artifact_id)
        return None

    def get_artifact_for_port(self, port: int) -> Optional[str]:
        """
        Get the artifact ID that owns a specific port.

        Args:
            port: Port number

        Returns:
            Artifact ID if port is allocated, None otherwise
        """
        if self.redis_client:
            try:
                return self.redis_client.hget(self.REDIS_KEY_ALLOCATED, str(port))
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to get artifact for port from Redis: {e}")
        return self._local_allocated.get(port)

    def is_port_available(self, port: int) -> bool:
        """
        Check if a specific port is available for allocation.

        Checks:
        - Port is in valid range (10000-19999)
        - Not already allocated in legacy artifact allocation
        - Not already allocated to a VM
        - Not in the evicted ports set
        - Not in use on the system (socket check)

        Args:
            port: Port number to check

        Returns:
            True if available, False otherwise
        """
        if port < self.PORT_RANGE_START or port > self.PORT_RANGE_END:
            return False

        # Check if already allocated (legacy)
        allocated = self._get_allocated_ports()
        if port in allocated:
            return False

        # Check VM allocations
        vm_allocated = self._get_vm_allocated_ports()
        if port in vm_allocated:
            return False

        # Check evicted ports
        evicted = self._get_evicted_ports()
        if port in evicted:
            return False

        # Check if in use by another process
        return not self._is_port_in_use(port)

    def get_allocated_count(self) -> int:
        """Get the number of currently allocated ports."""
        if self.redis_client:
            try:
                return self.redis_client.hlen(self.REDIS_KEY_ALLOCATED)
            except Exception:
                pass
        return len(self._local_allocated)

    def get_available_count(self) -> int:
        """Get the number of available ports in the pool."""
        total = self.PORT_RANGE_END - self.PORT_RANGE_START + 1
        return total - self.get_allocated_count()

    def list_allocations(self) -> List[Dict]:
        """
        List all current port allocations.

        Returns:
            List of {port, artifact_id} dictionaries
        """
        allocated = self._get_allocated_ports()
        return [
            {"port": port, "artifact_id": artifact_id}
            for port, artifact_id in sorted(allocated.items())
        ]

    def cleanup_stale_allocations(self) -> int:
        """
        Clean up port allocations that are no longer in use.

        Checks each allocated port to see if it's actually being used.
        If not, releases it back to the pool.

        Returns:
            Number of stale allocations cleaned up
        """
        cleaned = 0
        allocated = self._get_allocated_ports()

        for port, artifact_id in allocated.items():
            # If the port isn't actually in use, it's stale
            if not self._is_port_in_use(port):
                logger.info(f"{LOG_PREFIX} Cleaning up stale port allocation: {port} (artifact: {artifact_id})")
                self.release_port(port)
                cleaned += 1

        if cleaned > 0:
            logger.info(f"{LOG_PREFIX} Cleaned up {cleaned} stale port allocation(s)")

        return cleaned

    # =========================================================================
    # Per-VM Port Allocation (for server pools)
    # =========================================================================

    def _get_evicted_ports(self) -> set:
        """Get set of evicted ports (never to be reused)."""
        if self.redis_client:
            try:
                evicted = self.redis_client.smembers(self.REDIS_KEY_EVICTED)
                return {int(p) for p in evicted}
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to get evicted ports from Redis: {e}")
        return self._local_evicted.copy()

    def _get_vm_allocated_ports(self) -> Dict[int, str]:
        """Get all VM-allocated ports from Redis or local storage."""
        if self.redis_client:
            try:
                allocated = self.redis_client.hgetall(self.REDIS_KEY_PORT_TO_VM)
                return {int(k): v for k, v in allocated.items()}
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to get VM ports from Redis: {e}")
        return self._local_port_to_vm.copy()

    def allocate_port_for_vm(self, vm_id: str) -> Optional[int]:
        """
        Allocate an available port for a VM's server pool.

        Unlike artifact allocation, this:
        - Tracks port by VM ID (not artifact ID)
        - Never allocates evicted ports
        - Supports multiple ports per VM

        Args:
            vm_id: The Agent VM identifier

        Returns:
            Allocated port number, or None if no ports available
        """
        # Get all allocated ports (both legacy and VM)
        legacy_allocated = set(self._get_allocated_ports().keys())
        vm_allocated = set(self._get_vm_allocated_ports().keys())
        evicted = self._get_evicted_ports()

        all_unavailable = legacy_allocated | vm_allocated | evicted

        # Find available port - randomize for distribution
        available_range = list(range(self.PORT_RANGE_START, self.PORT_RANGE_END + 1))
        random.shuffle(available_range)

        for port in available_range:
            if port not in all_unavailable and not self._is_port_in_use(port):
                # Found available port - allocate it
                if self._store_vm_port_allocation(vm_id, port):
                    logger.info(f"{LOG_PREFIX} Allocated port {port} for VM {vm_id}")
                    return port

        logger.error(f"{LOG_PREFIX} No available ports for VM allocation")
        return None

    def _store_vm_port_allocation(self, vm_id: str, port: int) -> bool:
        """Store VM port allocation in Redis or local storage."""
        if self.redis_client:
            try:
                pipe = self.redis_client.pipeline()
                # Add to VM's port set
                pipe.sadd(f"{self.REDIS_KEY_VM_PORTS}{vm_id}", port)
                # Track port -> VM mapping
                pipe.hset(self.REDIS_KEY_PORT_TO_VM, str(port), vm_id)
                pipe.execute()
                return True
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to store VM port allocation in Redis: {e}")
                return False
        else:
            # Local storage
            if vm_id not in self._local_vm_ports:
                self._local_vm_ports[vm_id] = set()
            self._local_vm_ports[vm_id].add(port)
            self._local_port_to_vm[port] = vm_id
            return True

    def mark_port_evicted(self, port: int):
        """
        Mark a port as evicted - it will never be reused.

        Call this when a server is evicted from the pool.
        The port is removed from VM allocation but added to evicted set.

        Args:
            port: Port number to mark as evicted
        """
        if self.redis_client:
            try:
                pipe = self.redis_client.pipeline()
                # Add to evicted set
                pipe.sadd(self.REDIS_KEY_EVICTED, port)
                # Remove from port->VM mapping (but keep in VM's port set for history)
                pipe.hdel(self.REDIS_KEY_PORT_TO_VM, str(port))
                pipe.execute()
                logger.info(f"{LOG_PREFIX} Marked port {port} as evicted")
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to mark port evicted in Redis: {e}")
        else:
            self._local_evicted.add(port)
            self._local_port_to_vm.pop(port, None)
            logger.info(f"{LOG_PREFIX} Marked port {port} as evicted (local)")

    def get_vm_ports(self, vm_id: str) -> List[int]:
        """
        Get all ports currently allocated to a VM.

        Args:
            vm_id: The Agent VM identifier

        Returns:
            List of port numbers
        """
        if self.redis_client:
            try:
                ports = self.redis_client.smembers(f"{self.REDIS_KEY_VM_PORTS}{vm_id}")
                return [int(p) for p in ports]
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to get VM ports from Redis: {e}")
        return list(self._local_vm_ports.get(vm_id, set()))

    def release_vm_ports(self, vm_id: str) -> int:
        """
        Release all ports allocated to a VM.

        Call this when a VM is destroyed.

        Args:
            vm_id: The Agent VM identifier

        Returns:
            Number of ports released
        """
        ports = self.get_vm_ports(vm_id)
        released = 0

        if self.redis_client:
            try:
                pipe = self.redis_client.pipeline()
                # Remove from port->VM mapping
                for port in ports:
                    pipe.hdel(self.REDIS_KEY_PORT_TO_VM, str(port))
                # Remove VM's port set
                pipe.delete(f"{self.REDIS_KEY_VM_PORTS}{vm_id}")
                pipe.execute()
                released = len(ports)
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to release VM ports from Redis: {e}")
        else:
            for port in ports:
                self._local_port_to_vm.pop(port, None)
            self._local_vm_ports.pop(vm_id, None)
            released = len(ports)

        if released > 0:
            logger.info(f"{LOG_PREFIX} Released {released} ports for VM {vm_id}")

        return released

    def get_vm_for_port(self, port: int) -> Optional[str]:
        """
        Get the VM ID that owns a specific port.

        Args:
            port: Port number

        Returns:
            VM ID if port is allocated to a VM, None otherwise
        """
        if self.redis_client:
            try:
                return self.redis_client.hget(self.REDIS_KEY_PORT_TO_VM, str(port))
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to get VM for port from Redis: {e}")
        return self._local_port_to_vm.get(port)

    def is_port_evicted(self, port: int) -> bool:
        """
        Check if a port has been evicted (will never be reused).

        Args:
            port: Port number to check

        Returns:
            True if port is evicted, False otherwise
        """
        return port in self._get_evicted_ports()

    def get_evicted_count(self) -> int:
        """Get the number of evicted ports."""
        return len(self._get_evicted_ports())

    def clear_evicted_ports(self) -> int:
        """
        Clear the evicted ports set.

        Use with caution - only call when restarting the system.

        Returns:
            Number of evicted ports cleared
        """
        evicted = self._get_evicted_ports()
        count = len(evicted)

        if self.redis_client:
            try:
                self.redis_client.delete(self.REDIS_KEY_EVICTED)
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to clear evicted ports from Redis: {e}")
        else:
            self._local_evicted.clear()

        if count > 0:
            logger.info(f"{LOG_PREFIX} Cleared {count} evicted ports")

        return count


# Singleton instance
_port_allocator_instance: Optional[PortAllocator] = None


def get_port_allocator(redis_client=None) -> PortAllocator:
    """
    Get or create the singleton PortAllocator instance.

    Args:
        redis_client: Redis client (only used on first call)

    Returns:
        PortAllocator instance
    """
    global _port_allocator_instance

    if _port_allocator_instance is None:
        _port_allocator_instance = PortAllocator(redis_client)

    return _port_allocator_instance


def reset_port_allocator() -> None:
    """Reset the singleton instance (mainly for testing)."""
    global _port_allocator_instance
    _port_allocator_instance = None
