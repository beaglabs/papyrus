const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSafe });

    const starlings = b.dependency("starlings", .{ .target = target, .optimize = optimize });

    const exe = b.addExecutable(.{
        .name = "papyrus-hostd",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{ .name = "starlings", .module = starlings.module("starlings") }},
        }),
    });
    b.installArtifact(exe);

    const run = b.addRunArtifact(exe);
    run.stdin_behavior = .Pipe;
    if (b.args) |args| run.addArgs(args);
    b.step("run", "Run the sidecar against stdin").dependOn(&run.step);

    const unit_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{ .name = "starlings", .module = starlings.module("starlings") }},
        }),
    });
    b.step("test", "Run hostd unit tests").dependOn(&b.addRunArtifact(unit_tests).step);
}
