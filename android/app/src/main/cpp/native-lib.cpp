// The JNI bridge that starts Node — TASK-049.
//
// node::Start runs the event loop until the process ends, so it is called once, on a
// thread of its own (NodeRuntime.java), and never returns while the store is open.
// Node writes to stdout and stderr, which Android discards; both are piped to logcat
// under the tag "ChachiNode" so `adb logcat -s ChachiNode` shows what the server says.

#include <android/log.h>
#include <jni.h>
#include <pthread.h>
#include <unistd.h>

#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "node.h"

namespace {

const char *kTag = "ChachiNode";

struct Pipe {
  int fds[2];
  int priority;
};

Pipe out_pipe{{-1, -1}, ANDROID_LOG_INFO};
Pipe err_pipe{{-1, -1}, ANDROID_LOG_ERROR};

void *forward(void *arg) {
  auto *pipe = static_cast<Pipe *>(arg);
  char buffer[2048];
  ssize_t read_bytes;
  while ((read_bytes = read(pipe->fds[0], buffer, sizeof buffer - 1)) > 0) {
    // One log line per line written, so logcat reads like a terminal.
    if (buffer[read_bytes - 1] == '\n') read_bytes -= 1;
    buffer[read_bytes] = '\0';
    __android_log_write(pipe->priority, kTag, buffer);
  }
  return nullptr;
}

void redirect(int fd, Pipe &pipe) {
  setvbuf(fd == STDOUT_FILENO ? stdout : stderr, nullptr, _IOLBF, 0);
  if (::pipe(pipe.fds) != 0) return;
  dup2(pipe.fds[1], fd);
  pthread_t thread;
  if (pthread_create(&thread, nullptr, forward, &pipe) == 0) pthread_detach(thread);
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_store_chachisoftware_pos_NodeRuntime_startNodeWithArguments(
    JNIEnv *env, jclass /* clazz */, jobjectArray arguments) {
  const jsize count = env->GetArrayLength(arguments);

  // node::Start expects argv in one contiguous block, as a real process has it — libuv
  // reuses that memory for the process title.
  std::vector<std::string> copies;
  size_t total = 0;
  for (jsize i = 0; i < count; i += 1) {
    auto value = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
    const char *chars = env->GetStringUTFChars(value, nullptr);
    copies.emplace_back(chars);
    total += copies.back().size() + 1;
    env->ReleaseStringUTFChars(value, chars);
    env->DeleteLocalRef(value);
  }

  char *block = static_cast<char *>(calloc(total, 1));
  std::vector<char *> argv;
  char *cursor = block;
  for (const auto &copy : copies) {
    memcpy(cursor, copy.c_str(), copy.size());
    argv.push_back(cursor);
    cursor += copy.size() + 1;
  }

  redirect(STDOUT_FILENO, out_pipe);
  redirect(STDERR_FILENO, err_pipe);

  return static_cast<jint>(node::Start(static_cast<int>(argv.size()), argv.data()));
}
