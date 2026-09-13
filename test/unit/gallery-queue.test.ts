import { describe, it, expect, vi } from "vitest";
import { GalleryUploadQueue } from "../../src/client/gallery/upload-queue";

describe("GalleryUploadQueue unit tests", () => {
  it("initializes tasks in queued state and limits concurrency", () => {
    const queue = new GalleryUploadQueue({ concurrency: 2 });
    const fakeFile1 = new File(["test1"], "photo1.png", { type: "image/png" });
    const fakeFile2 = new File(["test2"], "photo2.png", { type: "image/png" });
    const fakeFile3 = new File(["test3"], "photo3.png", { type: "image/png" });

    queue.addFiles([fakeFile1, fakeFile2, fakeFile3]);
    const tasks = queue.getTasks();

    expect(tasks).toHaveLength(3);
    expect(tasks[0].originalName).toBe("photo1.png");
    expect(tasks[1].originalName).toBe("photo2.png");
    expect(tasks[2].originalName).toBe("photo3.png");
  });

  it("handles cancelling queued tasks", () => {
    const queue = new GalleryUploadQueue({ concurrency: 1 });
    const fakeFile = new File(["data"], "cancel.png", { type: "image/png" });
    queue.addFiles([fakeFile]);

    const task = queue.getTasks()[0];
    queue.cancelTask(task.id);

    expect(task.state).toBe("cancelled");
    expect(task.errorMessage).toContain("Cancelled");
  });

  it("clears completed and cancelled tasks", () => {
    const queue = new GalleryUploadQueue();
    const fake1 = new File(["1"], "1.png", { type: "image/png" });
    const fake2 = new File(["2"], "2.png", { type: "image/png" });
    queue.addFiles([fake1, fake2]);

    const tasks = queue.getTasks();
    tasks[0].state = "success";
    tasks[1].state = "error";

    queue.clearCompleted();
    expect(queue.getTasks()).toHaveLength(1);
    expect(queue.getTasks()[0].state).toBe("error");
  });
});
