"""Cross-platform advisory one-byte file lock for dashboard sidecars.

Transitional adapter until Windows-owned locks move into the Rust daemon.
Does not coordinate with the separately implemented document ingestion lock.
"""
import os

if os.name != "nt":
    import fcntl as fcntl
else:
    import msvcrt

    class _NativeWindowsFileLock:
        LOCK_EX = 2
        LOCK_NB = 4
        LOCK_UN = 8

        @staticmethod
        def flock(file, flags):
            fd = file if isinstance(file, int) else file.fileno()
            # All dashboard callers lock byte zero of their own dedicated
            # lockfiles; they MUST use this same adapter on native Windows.
            os.lseek(fd, 0, os.SEEK_SET)
            if flags & _NativeWindowsFileLock.LOCK_UN:
                command = msvcrt.LK_UNLCK
            elif flags & _NativeWindowsFileLock.LOCK_NB:
                command = msvcrt.LK_NBLCK
            elif flags & _NativeWindowsFileLock.LOCK_EX:
                command = msvcrt.LK_LOCK
            else:
                raise ValueError("unsupported file lock operation")
            msvcrt.locking(fd, command, 1)

    fcntl = _NativeWindowsFileLock
