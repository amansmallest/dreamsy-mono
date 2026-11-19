import { Footer } from "@/components/Footer";
import { Hero } from "@/components/hero/Hero";
import { EditorTeaser, Engine, FinalCta, HowItWorks, Kits, LibraryTeaser, Ticker } from "@/components/home/Sections";

export default function Home() {
  return (
    <>
      <main>
        <Hero />
        <Ticker />
        <HowItWorks />
        <Engine />
        <LibraryTeaser />
        <Kits />
        <EditorTeaser />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
