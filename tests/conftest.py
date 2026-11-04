import os

# In Tests keinen automatischen Abgleich mit Baserow im Hintergrund
os.environ.setdefault("BEETWERK_BASEROW_DELAY", "0")
