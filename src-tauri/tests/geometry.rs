//! Tests for the pure standalone-geometry resolver.
//!
//! The full `WindowGeometry::resolve` entry point pulls in the OS (monitor
//! lookup, `settings.json` read); the tests here cover `resolve_standalone_from_parts`
//! which is the deterministic core.

use app_lib::setup::geometry::resolve_standalone_from_parts;

/// Standard 1920×1080 primary monitor, no taskbar clipped, 1.0 scale.
const WORK_AREA_1080P: (i32, i32, i32, i32) = (0, 0, 1920, 1040);
const SCALE_1X: f64 = 1.0;

#[test]
fn default_1280x800_centers_in_work_area()
{
    let g = resolve_standalone_from_parts(None, None, false, WORK_AREA_1080P, SCALE_1X);
    assert!(!g.maximized);
    assert_eq!(g.logical_width, 1280.0);
    assert_eq!(g.logical_height, 800.0);
    // (1920 - 1280) / 2 = 320
    assert_eq!(g.logical_x, 320.0);
    // (1040 - 800) / 2 = 120
    assert_eq!(g.logical_y, 120.0);
    assert_eq!(g.min_logical_width, 640.0);
    assert_eq!(g.min_logical_height, 640.0);
    assert!(g.resizable);
}

#[test]
fn saved_1600x900_centers_in_work_area()
{
    let g = resolve_standalone_from_parts(
        Some(1600.0),
        Some(900.0),
        false,
        WORK_AREA_1080P,
        SCALE_1X,
    );
    assert_eq!(g.logical_width, 1600.0);
    assert_eq!(g.logical_height, 900.0);
    // (1920 - 1600) / 2 = 160
    assert_eq!(g.logical_x, 160.0);
    // (1040 - 900) / 2 = 70
    assert_eq!(g.logical_y, 70.0);
}

#[test]
fn maximized_fills_work_area()
{
    let g = resolve_standalone_from_parts(
        Some(1280.0),
        Some(800.0),
        true,
        WORK_AREA_1080P,
        SCALE_1X,
    );
    assert!(g.maximized);
    // Work-area rect, converted logical (scale = 1).
    assert_eq!(g.logical_x, 0.0);
    assert_eq!(g.logical_y, 0.0);
    assert_eq!(g.logical_width, 1920.0);
    assert_eq!(g.logical_height, 1040.0);
    assert!(g.resizable);
}

#[test]
fn tiny_saved_size_floors_at_1080x640()
{
    let g = resolve_standalone_from_parts(
        Some(500.0),
        Some(400.0),
        false,
        WORK_AREA_1080P,
        SCALE_1X,
    );
    // Floors kick in.
    assert_eq!(g.logical_width, 1080.0);
    assert_eq!(g.logical_height, 640.0);
    // (1920 - 1080) / 2 = 420
    assert_eq!(g.logical_x, 420.0);
    // (1040 - 640) / 2 = 200
    assert_eq!(g.logical_y, 200.0);
}

#[test]
fn taskbar_offset_work_area_positions_relative()
{
    // Simulate a 40px taskbar at the top of a 1920×1080 physical screen.
    let work_area = (0, 40, 1920, 1080);
    let g = resolve_standalone_from_parts(None, None, false, work_area, SCALE_1X);
    // Y offset baseline moves down by taskbar height.
    // wa_h_logical = 1040; (1040 - 800) / 2 = 120; + wa_top(40) = 160.
    assert_eq!(g.logical_y, 160.0);
}

#[test]
fn maximized_with_taskbar_covers_only_work_area()
{
    let work_area = (0, 0, 1920, 1040);  // 40px taskbar at bottom
    let g = resolve_standalone_from_parts(None, None, true, work_area, SCALE_1X);
    assert!(g.maximized);
    assert_eq!(g.logical_width, 1920.0);
    assert_eq!(g.logical_height, 1040.0);
}

#[test]
fn high_dpi_scale_2x_divides_work_area()
{
    // 2× DPI: 3840×2160 physical work area, logical = 1920×1080.
    let work_area = (0, 0, 3840, 2160);
    let g = resolve_standalone_from_parts(None, None, false, work_area, 2.0);
    assert_eq!(g.scale_factor, 2.0);
    assert_eq!(g.logical_width, 1280.0);
    assert_eq!(g.logical_height, 800.0);
    // Logical work area = 1920×1080; (1920-1280)/2 = 320.
    assert_eq!(g.logical_x, 320.0);
    assert_eq!(g.logical_y, 140.0);
    // Physical origin doubles.
    assert_eq!(g.physical_origin(), (640, 280));
    assert_eq!(g.physical_size(), (2560, 1600));
}
