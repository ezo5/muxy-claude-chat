"""How busy this machine is, for the rail's Performance card. Linux only: it reads /proc, and elsewhere says so.

CPU can only be told over a stretch of time, and an op keeps nothing between calls, so it looks twice, a moment apart."""
import os
import time

WINDOW_S = 0.5
TOP = 5


def cpu_times():
    """→ (all jiffies, idle jiffies) of the whole machine."""
    with open("/proc/stat") as f:
        fields = [int(x) for x in f.readline().split()[1:]]
    # Guest time is already counted in user time.
    return sum(fields[:8]), fields[3] + fields[4]


def processes(own):
    """→ {pid: (name, jiffies, resident pages)}. A process may end while it's read."""
    out = {}
    for name in os.listdir("/proc"):
        if not name.isdigit() or int(name) == own:
            continue
        try:
            with open("/proc/%s/stat" % name) as f:
                text = f.read()
        except OSError:
            continue
        # The name may hold spaces and parentheses, so the fields are counted from its last ")".
        at = text.rfind(")")
        fields = text[at + 2:].split()
        out[int(name)] = (text[text.find("(") + 1:at], int(fields[11]) + int(fields[12]), int(fields[21]))
    return out


def memory():
    """→ (total, used) bytes. Used is what can't be had back: cache doesn't count."""
    found = {}
    with open("/proc/meminfo") as f:
        for line in f:
            key, _, rest = line.partition(":")
            if key in ("MemTotal", "MemAvailable"):
                found[key] = int(rest.split()[0]) * 1024
    return found["MemTotal"], found["MemTotal"] - found["MemAvailable"]


def op_perf(req):
    if not os.path.exists("/proc/stat"):
        return {"supported": False}
    own = os.getpid()
    total_before, idle_before = cpu_times()
    before = processes(own)
    started = time.monotonic()
    time.sleep(WINDOW_S)
    total_after, idle_after = cpu_times()
    after = processes(own)
    elapsed = time.monotonic() - started
    all_jiffies = max(1, total_after - total_before)
    cpu = 100.0 * (all_jiffies - (idle_after - idle_before)) / all_jiffies
    hz = os.sysconf("SC_CLK_TCK")
    page = os.sysconf("SC_PAGE_SIZE")
    rows = []
    for pid, (name, jiffies, pages) in after.items():
        was = before.get(pid)
        used = jiffies - was[1] if was is not None else 0
        rows.append({"pid": pid, "name": name, "cpu": round(100.0 * used / (hz * elapsed), 1), "mem": pages * page})
    rows.sort(key=lambda r: (-r["cpu"], -r["mem"]))
    mem_total, mem_used = memory()
    return {"supported": True, "cpu": round(cpu, 1), "cores": os.cpu_count(), "memTotal": mem_total, "memUsed": mem_used, "top": rows[:TOP]}
