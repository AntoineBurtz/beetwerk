"""Startet Beetwerk mit den Rechten von PUID:PGID.

Läuft der Container als root (Standard), wird der Datenordner diesem
Benutzer übergeben und das Programm danach ohne root-Rechte gestartet.
Unraid nutzt üblicherweise 99:100 (nobody:users), sonst ist 1000:1000 üblich.
Wird der Container schon mit --user gestartet, passiert hier nichts.
"""
import os
import sys

data = os.environ.get("BEETWERK_DATA", "/data")

if os.getuid() == 0:
    uid = int(os.environ.get("PUID", "1000"))
    gid = int(os.environ.get("PGID", "1000"))
    os.makedirs(data, exist_ok=True)
    for name in [data, *(os.path.join(data, f) for f in os.listdir(data))]:
        st = os.lstat(name)
        if st.st_uid != uid or st.st_gid != gid:
            os.chown(name, uid, gid, follow_symlinks=False)
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)
    os.environ["HOME"] = data

os.execvp(sys.argv[1], sys.argv[1:])
