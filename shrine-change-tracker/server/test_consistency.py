"""
Shrine Change Tracker — Consistency Test

Runs the analysis on a single image multiple times to measure
how consistent the vision model's counts are between runs.

Usage:
    1. Make sure Ollama is running (ollama serve)
    2. Make sure the server is running (python server.py)
    3. Run: python test_consistency.py

Results are printed as a table and saved to test_results.json.
"""

import json
import sys
import time
import statistics
import requests

SERVER = "http://localhost:5000"

# Default: Largo Preneste shrine, 2008 image (known to have items)
DEFAULT_PANO_ID = "47x1tHcNc-nd5wD3i-aQEw"
DEFAULT_HEADING = 271.05
DEFAULT_PITCH = -2.26

NUM_RUNS = 4
CATEGORIES = ["plaques", "flowers", "candles", "pictures", "other", "total"]


def check_server():
    try:
        r = requests.get(f"{SERVER}/health", timeout=5)
        data = r.json()
        if data.get("ollama") != "connected":
            print("ERROR: Ollama is not connected. Run 'ollama serve' first.")
            return False
        if not data.get("model"):
            print("ERROR: Model not installed. Run 'ollama pull gemma3:4b' first.")
            return False
        print(f"Server OK. Model: {data['model']}")
        return True
    except Exception as e:
        print(f"ERROR: Cannot connect to server at {SERVER}. Run 'python server.py' first.")
        print(f"  Details: {e}")
        return False


def analyze_once(pano_id, heading, pitch, crop=None):
    payload = {
        "pano_id": pano_id,
        "heading": heading,
        "pitch": pitch,
    }
    if crop:
        payload["crop"] = crop

    r = requests.post(
        f"{SERVER}/analyze-image",
        json=payload,
        timeout=600,
    )
    return r.json()


def run_consistency_test(pano_id, heading, pitch, crop=None, num_runs=NUM_RUNS):
    print(f"\nRunning {num_runs} analyses on pano_id={pano_id}")
    if crop:
        print(f"  Focus region: x={crop['x']:.2f} y={crop['y']:.2f} w={crop['w']:.2f} h={crop['h']:.2f}")
    print(f"  heading={heading}, pitch={pitch}")
    print()

    results = []
    for i in range(num_runs):
        print(f"  Run {i + 1}/{num_runs}...", end=" ", flush=True)
        start = time.time()
        data = analyze_once(pano_id, heading, pitch, crop)
        elapsed = time.time() - start

        if "error" in data:
            print(f"ERROR: {data['error']}")
            continue

        print(f"total={data['total']} ({elapsed:.1f}s)")
        results.append(data)

    if len(results) < 2:
        print("\nNot enough successful runs to compute statistics.")
        return results

    # Compute statistics
    print("\n" + "=" * 70)
    print("RESULTS")
    print("=" * 70)
    print(f"{'Category':<12} {'Runs':>50}  {'Mean':>6} {'StdDev':>7} {'CV%':>6}")
    print("-" * 70)

    stats = {}
    for cat in CATEGORIES:
        values = [r.get(cat, 0) for r in results]
        mean = statistics.mean(values)
        stdev = statistics.stdev(values) if len(values) > 1 else 0
        cv = (stdev / mean * 100) if mean > 0 else 0
        vals_str = ", ".join(str(v) for v in values)
        print(f"  {cat:<10} {vals_str:>50}  {mean:>6.1f} {stdev:>7.2f} {cv:>5.1f}%")
        stats[cat] = {
            "values": values,
            "mean": round(mean, 2),
            "stdev": round(stdev, 2),
            "cv_percent": round(cv, 1),
        }

    print("-" * 70)

    # Overall consistency assessment
    total_cv = stats["total"]["cv_percent"]
    if total_cv < 10:
        grade = "GOOD"
        desc = "Counts are consistent enough for reliable trend detection."
    elif total_cv < 25:
        grade = "ACCEPTABLE"
        desc = "Some variance, but trends (up/down) should still be detectable."
    else:
        grade = "HIGH VARIANCE"
        desc = "Counts vary significantly. Consider using the focus region or a larger model."

    print(f"\n  Consistency: {grade} (total CV = {total_cv:.1f}%)")
    print(f"  {desc}")

    return {
        "pano_id": pano_id,
        "heading": heading,
        "pitch": pitch,
        "crop": crop,
        "num_runs": len(results),
        "runs": results,
        "stats": stats,
        "grade": grade,
    }


def run_multi_image_test():
    """Test multiple images from the demo location to check trend consistency."""
    demo_panos = [
        ("47x1tHcNc-nd5wD3i-aQEw", "2008-05"),
        ("jVczeIKJAfc-edVQsi3wUg", "2017-08"),
        ("Dpgy8eH_lXO4vkldh5-wvw", "2025-05"),
    ]

    print("\n\n" + "=" * 70)
    print("MULTI-IMAGE TREND TEST")
    print("Analyzing 3 images across time, 2 runs each, to check trend stability")
    print("=" * 70)

    all_runs = {}
    for pano_id, date in demo_panos:
        print(f"\n--- {date} ---")
        results = []
        for i in range(2):
            print(f"  Run {i + 1}/2...", end=" ", flush=True)
            start = time.time()
            data = analyze_once(pano_id, DEFAULT_HEADING, DEFAULT_PITCH)
            elapsed = time.time() - start
            if "error" not in data:
                print(f"total={data['total']} ({elapsed:.1f}s)")
                results.append(data)
            else:
                print(f"ERROR: {data['error']}")
        all_runs[date] = results

    # Check if trends are consistent
    print("\n" + "=" * 70)
    print("TREND ANALYSIS")
    print("=" * 70)
    dates = list(all_runs.keys())
    for i in range(len(dates) - 1):
        d1, d2 = dates[i], dates[i + 1]
        r1 = all_runs[d1]
        r2 = all_runs[d2]
        if r1 and r2:
            avg1 = statistics.mean([r["total"] for r in r1])
            avg2 = statistics.mean([r["total"] for r in r2])
            direction = "INCREASED" if avg2 > avg1 else "DECREASED" if avg2 < avg1 else "UNCHANGED"
            diff = avg2 - avg1
            pct = ((avg2 - avg1) / avg1 * 100) if avg1 > 0 else 0
            print(f"  {d1} → {d2}: {avg1:.0f} → {avg2:.0f} items ({direction}, {diff:+.0f}, {pct:+.0f}%)")

            # Check if both runs agree on direction
            dirs = []
            for r1_run in r1:
                for r2_run in r2:
                    dirs.append("up" if r2_run["total"] > r1_run["total"] else "down" if r2_run["total"] < r1_run["total"] else "same")
            agreement = len(set(dirs)) == 1
            print(f"    Direction agreement: {'YES — all runs agree' if agreement else 'NO — runs disagree on direction'}")

    return all_runs


if __name__ == "__main__":
    if not check_server():
        sys.exit(1)

    # Test 1: Single-image consistency (4 runs)
    single_result = run_consistency_test(
        DEFAULT_PANO_ID, DEFAULT_HEADING, DEFAULT_PITCH,
        num_runs=4,
    )

    # Test 2: Multi-image trend test
    trend_result = run_multi_image_test()

    # Save results
    output = {
        "single_image_consistency": single_result,
        "trend_test_runs": {k: v for k, v in (trend_result or {}).items()},
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    out_path = "test_results.json"
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2, default=str)
    print(f"\nResults saved to {out_path}")
