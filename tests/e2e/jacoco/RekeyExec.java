import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.jacoco.cli.internal.asm.Label;
import org.jacoco.cli.internal.core.data.ExecutionData;
import org.jacoco.cli.internal.core.data.ExecutionDataWriter;
import org.jacoco.cli.internal.core.data.SessionInfo;
import org.jacoco.cli.internal.core.internal.data.CRC64;
import org.jacoco.cli.internal.core.internal.flow.ClassProbesAdapter;
import org.jacoco.cli.internal.core.internal.flow.ClassProbesVisitor;
import org.jacoco.cli.internal.core.internal.flow.IFrame;
import org.jacoco.cli.internal.core.internal.flow.LabelInfo;
import org.jacoco.cli.internal.core.internal.flow.MethodProbesVisitor;
import org.jacoco.cli.internal.core.internal.instr.InstrSupport;
import org.jacoco.cli.internal.core.tools.ExecFileLoader;

/**
 * Re-keys a JaCoCo .exec to the classes an IDE compiled, so IntelliJ's Run › Show Coverage Data can show it
 * (coverage spike, tests/e2e/run-coverage.mjs). JaCoCo — and IntelliJ, which runs JaCoCo's own Analyzer over the
 * module's output folders — only applies hits to a class whose bytes have the exact checksum that ran. On NeoForge
 * that is already true; on Fabric the deployed jar is remapped (every class re-serialized) and the loader strips
 * client-only members on a server, so no class matches.
 *
 * <p>For each class: if the IDE's bytes are the ones that ran, the data is copied as is. Otherwise the hits are
 * carried method by method — a method in both, with the same number of probes, keeps its hits under the IDE
 * class's probe numbering; a method only the IDE has (a stripped client-only one) reads as not run. Methods are
 * matched by name and descriptor shape (class names erased: remapping renames classes, it doesn't move code), then,
 * for overrides of Minecraft methods that remapping renamed, by shape and probe count in file order.
 *
 * <pre>java -cp org.jacoco.cli-0.8.12-nodeps.jar RekeyExec.java in.exec ranClassesDir ideClassesDir out.exec</pre>
 * {@code ranClassesDir} holds the bytes that ran: the agent's {@code classdumpdir}.
 */
public final class RekeyExec {

    /** {@code key}: name + descriptor shape + occurrence; {@code shape}: the descriptor with class names erased. */
    private record Method(String name, String shape, String key, int first, int last) {
        int count() {
            return first < 0 ? 0 : last - first + 1;
        }
    }

    public static void main(String[] args) throws IOException {
        if (args.length != 4) {
            System.err.println("usage: RekeyExec in.exec ranClassesDir ideClassesDir out.exec");
            System.exit(2);
        }
        ExecFileLoader loader = new ExecFileLoader();
        loader.load(Path.of(args[0]).toFile());
        Map<Long, byte[]> ranById = new HashMap<>();
        for (byte[] b : classFiles(Path.of(args[1]))) {
            ranById.put(CRC64.classId(b), b);
        }
        Map<String, byte[]> ideByName = new HashMap<>();
        for (byte[] b : classFiles(Path.of(args[2]))) {
            ideByName.put(InstrSupport.classReaderFor(b).getClassName(), b);
        }

        int same = 0;
        int rekeyed = 0;
        int dropped = 0;
        try (OutputStream out = new FileOutputStream(args[3])) {
            ExecutionDataWriter writer = new ExecutionDataWriter(out);
            for (SessionInfo s : loader.getSessionInfoStore().getInfos()) {
                writer.visitSessionInfo(s);
            }
            for (ExecutionData d : loader.getExecutionDataStore().getContents()) {
                byte[] ide = ideByName.get(d.getName());
                byte[] ran = ranById.get(d.getId());
                if (ide == null) {
                    dropped++; // not one of the IDE's classes (a library, another module)
                    continue;
                }
                long ideId = CRC64.classId(ide);
                if (ideId == d.getId()) {
                    writer.visitClassExecution(d);
                    same++;
                    continue;
                }
                if (ran == null) {
                    System.out.println("  " + d.getName() + ": no copy of the bytes that ran (classdumpdir?) — left out");
                    dropped++;
                    continue;
                }
                List<Method> ranMethods = new ArrayList<>();
                probes(ran, ranMethods);
                List<Method> ideMethods = new ArrayList<>();
                boolean[] hits = new boolean[probes(ide, ideMethods)];
                boolean[] ranHits = d.getProbes();
                List<String> notCarried = new ArrayList<>();
                for (Map.Entry<Method, Method> pair : align(ideMethods, ranMethods, notCarried).entrySet()) {
                    Method m = pair.getKey();
                    System.arraycopy(ranHits, pair.getValue().first(), hits, m.first(), m.count());
                }
                writer.visitClassExecution(new ExecutionData(ideId, d.getName(), hits));
                rekeyed++;
                if (!notCarried.isEmpty()) {
                    System.out.println("  " + d.getName() + ": not in the class that ran, so not run: "
                            + String.join(", ", notCarried));
                }
            }
        }
        System.out.println("rekeyed " + rekeyed + ", already matching " + same + ", left out " + dropped);
    }

    /**
     * Pairs each IDE method that has probes with the method that ran. First by name and descriptor shape; then, in
     * file order, the rest by shape and probe count alone: remapping renames a method that overrides a Minecraft one
     * ({@code send} is {@code method_10743} in the jar) but keeps members in order. IDE methods left over were not in
     * the class that ran (stripped); their names go to {@code notCarried}.
     */
    private static Map<Method, Method> align(List<Method> ide, List<Method> ran, List<String> notCarried) {
        Map<Method, Method> pairs = new java.util.LinkedHashMap<>();
        Map<String, Method> ranByKey = new HashMap<>();
        for (Method r : ran) {
            ranByKey.put(r.key(), r);
        }
        java.util.Set<Method> used = new java.util.HashSet<>();
        for (Method m : ide) {
            Method r = ranByKey.get(m.key());
            if (m.count() > 0 && r != null && r.count() == m.count()) {
                pairs.put(m, r);
                used.add(r);
            }
        }
        int from = 0;
        for (Method m : ide) {
            if (m.count() == 0 || pairs.containsKey(m)) {
                continue;
            }
            for (int i = from; i < ran.size(); i++) {
                Method r = ran.get(i);
                if (!used.contains(r) && r.shape().equals(m.shape()) && r.count() == m.count()) {
                    pairs.put(m, r);
                    used.add(r);
                    from = i + 1;
                    break;
                }
            }
            if (!pairs.containsKey(m)) {
                notCarried.add(m.name());
            }
        }
        return pairs;
    }

    /** Every .class under {@code dir}. */
    private static List<byte[]> classFiles(Path dir) throws IOException {
        List<byte[]> out = new ArrayList<>();
        try (Stream<Path> files = Files.walk(dir)) {
            for (Path p : (Iterable<Path>) files.filter(f -> f.toString().endsWith(".class"))::iterator) {
                out.add(Files.readAllBytes(p));
            }
        }
        return out;
    }

    /** Each method's probe range, numbered exactly as JaCoCo's instrumenter and analyzer number them; returns the total. */
    private static int probes(byte[] bytes, List<Method> methods) {
        int[] total = new int[1];
        Map<String, Integer> seen = new HashMap<>();
        ClassProbesVisitor visitor = new ClassProbesVisitor() {
            @Override
            public MethodProbesVisitor visitMethod(int access, String name, String desc, String signature,
                    String[] exceptions) {
                String shape = desc.replaceAll("L[^;]+;", "L;");
                int n = seen.merge(name + shape, 1, Integer::sum);
                String key = name + shape + "#" + n;
                int[] range = {Integer.MAX_VALUE, -1};
                return new MethodProbesVisitor() {
                    private void see(int id) {
                        if (id >= 0) {
                            range[0] = Math.min(range[0], id);
                            range[1] = Math.max(range[1], id);
                        }
                    }

                    @Override
                    public void visitProbe(int id) {
                        see(id);
                    }

                    @Override
                    public void visitJumpInsnWithProbe(int opcode, Label label, int id, IFrame frame) {
                        see(id);
                    }

                    @Override
                    public void visitInsnWithProbe(int opcode, int id) {
                        see(id);
                    }

                    @Override
                    public void visitTableSwitchInsnWithProbes(int min, int max, Label dflt, Label[] labels, IFrame frame) {
                        see(LabelInfo.getProbeId(dflt));
                        for (Label l : labels) {
                            see(LabelInfo.getProbeId(l));
                        }
                    }

                    @Override
                    public void visitLookupSwitchInsnWithProbes(Label dflt, int[] keys, Label[] labels, IFrame frame) {
                        see(LabelInfo.getProbeId(dflt));
                        for (Label l : labels) {
                            see(LabelInfo.getProbeId(l));
                        }
                    }

                    @Override
                    public void visitEnd() {
                        methods.add(range[1] < 0 ? new Method(name, shape, key, -1, -1)
                                : new Method(name, shape, key, range[0], range[1]));
                    }
                };
            }

            @Override
            public void visitTotalProbeCount(int count) {
                total[0] = count;
            }
        };
        InstrSupport.classReaderFor(bytes).accept(new ClassProbesAdapter(visitor, false), 0);
        return total[0];
    }
}
